# Connecting to HMRC

The checker uses HMRC's **Check a UK VAT number** API, version 2.0
(service name `vat-registered-companies-api`). It is an *application-restricted*
API: it needs credentials for the firm's application, but no client
authorisation and no Government Gateway sign-in per check.

| | Sandbox | Production |
|---|---|---|
| Base URL | `https://test-api.service.hmrc.gov.uk` | `https://api.service.hmrc.gov.uk` |
| Token | `POST /oauth/token` (`grant_type=client_credentials`) | same |
| Lookup | `GET /organisations/vat/check-vat-number/lookup/{targetVrn}[/{requesterVrn}]` | same |
| Accept header | `application/vnd.hmrc.2.0+json` | same |
| Rate limit | 3 requests/second per application (default) | same |

## 1. Register (someone at the firm does this. It can't be automated)

1. Create an account at <https://developer.service.hmrc.gov.uk/> using a shared
   team mailbox (for example tax-technology@…) rather than a personal one, so the
   account outlives any one person.
2. Turn on 2-step verification for the account.
3. Go to **Applications → Add an application to the sandbox**. Use a name like
   "Forvis Mazars VAT Registration Checker".
4. On the application, choose **API subscriptions** and subscribe to
   **Check a UK VAT number, v2.0**.
5. Under **Credentials**, copy the **Client ID** and generate a **Client secret**.

## 2. Test against the sandbox

```bash
cp .env.example .env
# edit .env:
HMRC_MODE=sandbox
HMRC_CLIENT_ID=<sandbox client id>
HMRC_CLIENT_SECRET=<sandbox client secret>
HMRC_REQUESTER_VRN=<a sandbox test VRN, optional>
npm start
```

Sandbox data is synthetic. Create test organisations with the Developer Hub's
**Create Test User** service and use their VAT numbers. HMRC's documentation
also lists example VRNs. Sandbox VRNs often fail the UK check-digit test. The
tool still sends them to HMRC and shows a "possible typo" note.

## 3. Go live

1. On the Developer Hub, choose **Add an application to production** and
   complete HMRC's production approval questionnaire. This covers what the
   software does, data handling, security and terms of use. HMRC reviews it
   before it issues production credentials.
2. Set `HMRC_MODE=production`, add the production client ID and secret, and set
   `HMRC_REQUESTER_VRN` to the **firm's own VAT number**.
3. Restart. The header badge then shows **HMRC Live**.

### Why set the requester VRN?

When the request includes our VRN, HMRC returns a **consultation number** with
each successful check. That is HMRC's own reference proving the check took place
on that date. It's stored on each result, in the audit log and in the evidence
pack. Without it we hold only our own record of the response.

## Keeping credentials safe

* Never commit `.env`. It's already in `.gitignore`.
* In Azure or AWS, put the secret in Key Vault or Secrets Manager and inject it
  as an environment variable.
* Rotate the client secret on the Developer Hub if anyone with access leaves.

document.getElementById('year').textContent = new Date().getFullYear();

const form = document.getElementById('book-form');
const msg = document.getElementById('form-msg');
const dateInput = form.elements.date;
dateInput.min = new Date().toISOString().split('T')[0];

form.addEventListener('submit', (e) => {
  e.preventDefault();
  let valid = true;
  form.querySelectorAll('[required]').forEach((el) => {
    const ok = el.value.trim() !== '' && el.checkValidity();
    el.classList.toggle('invalid', !ok);
    if (!ok) valid = false;
  });

  msg.classList.toggle('error', !valid);
  if (!valid) {
    msg.textContent = 'Please fill in the highlighted fields.';
    return;
  }

  // Demo only: no backend yet. Hook this up to a form service or API to receive bookings.
  const dog = form.elements.dog.value.trim();
  msg.textContent = `Thanks! We'll be in touch shortly to confirm ${dog}'s walk. 🐾`;
  form.reset();
});

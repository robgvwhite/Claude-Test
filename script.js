(function () {
  var s = window.SITE;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  document.title = s.name + " | Professional Portfolio";
  $("brand").textContent = s.name;
  $("name").textContent = s.name;
  $("headline").textContent = s.headline;
  $("location").textContent = s.location;
  $("footName").textContent = s.name;
  $("year").textContent = new Date().getFullYear();
  ["navLinkedin", "heroLinkedin", "footLinkedin"].forEach(function (id) { $(id).href = s.linkedin; });

  s.stats.forEach(function (x) {
    var li = el("li");
    li.appendChild(el("strong", "", x.value));
    li.appendChild(el("span", "", x.label));
    $("stats").appendChild(li);
  });

  s.about.forEach(function (p) { $("aboutText").appendChild(el("p", "", p)); });
  s.skills.forEach(function (k) { $("skills").appendChild(el("li", "", k)); });

  s.experience.forEach(function (x) {
    var li = el("li");
    li.appendChild(el("h3", "", x.role));
    li.appendChild(el("p", "meta", x.company + " · " + x.dates));
    li.appendChild(el("p", "", x.summary));
    $("timeline").appendChild(li);
  });

  s.posts.forEach(function (p) {
    var card = el("article", "card");
    card.appendChild(el("p", "meta", p.date));
    card.appendChild(el("h3", "", p.title));
    card.appendChild(el("p", "", p.excerpt));
    var tags = el("ul", "chips");
    p.tags.forEach(function (t) { tags.appendChild(el("li", "", t)); });
    card.appendChild(tags);
    if (p.stats) card.appendChild(el("p", "meta", p.stats));
    var a = el("a", "more", "Read on LinkedIn →");
    a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    card.appendChild(a);
    $("postGrid").appendChild(card);
  });
})();

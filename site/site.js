// Socha Diff download site: small progressive enhancements, no dependencies.
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  // Reveal-on-scroll.
  var items = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add("in"); });
  }

  // Copy buttons for the "check what you have" commands.
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
        ta.remove();
      }
    });
  });

  // Gentle hint when the visitor is not on Windows.
  var ua = navigator.userAgent || "";
  if (!/Windows/i.test(ua)) {
    var fine = document.querySelector(".hero .fineprint");
    if (fine) {
      var p = document.createElement("p");
      p.className = "os-hint";
      p.textContent = /Android|iPhone|iPad|Mobile/i.test(ua)
        ? "Socha Diff is a Windows desktop app. Open this page on your Windows PC to install it."
        : "Socha Diff is a Windows desktop app for Windows 10/11 (x64). Open this page on your Windows PC to install it.";
      fine.after(p);
    }
  }
})();

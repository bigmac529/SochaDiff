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

  // Demo video: GIF fallback if the video cannot play; honor reduced motion; pause button.
  var video = document.getElementById("demo-video");
  var toggle = document.getElementById("demo-toggle");
  if (video) {
    var useGif = function () {
      var img = document.createElement("img");
      img.src = "assets/demo.gif";
      img.alt = "Socha Diff demo recording";
      img.width = 960; img.height = 600;
      video.replaceWith(img);
      if (toggle) toggle.remove();
    };
    var sources = video.querySelectorAll("source");
    var failed = 0;
    sources.forEach(function (s) {
      s.addEventListener("error", function () { if (++failed === sources.length) useGif(); });
    });
    var setPaused = function (paused) {
      if (paused) video.pause(); else video.play().catch(function () {});
      if (toggle) { toggle.textContent = paused ? "Play" : "Pause"; toggle.setAttribute("aria-pressed", String(paused)); }
    };
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.removeAttribute("autoplay");
      setPaused(true);
    }
    if (toggle) toggle.addEventListener("click", function () { setPaused(!video.paused); });
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
        : "Socha Diff installs on Windows 10/11 (x64). On this computer you can run the web version from source.";
      fine.after(p);
    }
  }
})();

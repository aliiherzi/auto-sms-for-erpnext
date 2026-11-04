// Runs before the dashboard. As the app on GitHub Pages it opens with sample data: it loads a
// pretend server (demo/demo-api.js) so every screen works until you connect your real server.
(function () {
  var mode = null;
  try {
    mode = localStorage.getItem('asms.mode');
  } catch (e) {
    mode = null;
  }
  function load(src) {
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    });
  }
  // First visit (no choice saved yet) opens straight into the demo.
  window.AUTO_SMS_READY =
    window.AUTO_SMS_STATIC === true && (mode === null || mode === 'demo')
      ? load('demo/demo-data.js').then(function () {
          return load('demo/demo-api.js');
        })
      : Promise.resolve();
})();

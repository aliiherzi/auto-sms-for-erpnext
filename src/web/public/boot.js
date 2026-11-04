// Runs before the dashboard. As the app on GitHub Pages, "Look around with sample data"
// loads a pretend server (demo/demo-api.js) so every screen works without a real server.
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
  window.AUTO_SMS_READY =
    window.AUTO_SMS_STATIC === true && mode === 'demo'
      ? load('demo/demo-data.js').then(function () {
          return load('demo/demo-api.js');
        })
      : Promise.resolve();
})();

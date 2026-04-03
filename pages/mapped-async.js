console.log("mapped async bundle loaded");
window.runMappedFixture = function() {
  setTimeout(function mappedTimeout() {
    console.log("mapped timeout");
  }, 10);
};
//# sourceMappingURL=mapped-async.js.map

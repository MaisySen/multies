/* Multies: .at() for older browsers (Sentry MYMAIL-WEB-2, Chrome Mobile 90 and Safari before 15.4).
   A classic script, so it runs before any module and any shared chunk, whatever order the bundle uses. */
(function () {
  function at(index) {
    var n = Math.trunc(Number(index)) || 0;
    var i = n < 0 ? this.length + n : n;
    return i < 0 || i >= this.length ? undefined : this[i];
  }
  var names = ["Array", "String", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"];
  for (var k = 0; k < names.length; k++) {
    var C = window[names[k]];
    if (C && typeof C.prototype.at !== "function") {
      Object.defineProperty(C.prototype, "at", { value: at, writable: true, enumerable: false, configurable: true });
    }
  }
})();

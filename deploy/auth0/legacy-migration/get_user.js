function getByEmail(email, callback) {
  // Used by sign up and Forgot password: a person who is still only on the old tenant is
  // found here, so a reset creates them on this tenant. If the old tenant cannot be reached,
  // answer "not found" so sign up never breaks.
  var base = "https://" + configuration.OLD_DOMAIN;
  fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: configuration.OLD_LOOKUP_CLIENT_ID,
      client_secret: configuration.OLD_LOOKUP_CLIENT_SECRET,
      audience: base + "/api/v2/"
    })
  }).then(function (res) {
    if (!res.ok) throw new Error("legacy_token_" + res.status);
    return res.json();
  }).then(function (tok) {
    return fetch(base + "/api/v2/users-by-email?email=" + encodeURIComponent(email), {
      headers: { authorization: "Bearer " + tok.access_token }
    }).then(function (r) {
      if (!r.ok) throw new Error("legacy_lookup_" + r.status);
      return r.json();
    });
  }).then(function (list) {
    var u = (list || []).filter(function (x) {
      return (x.identities || []).some(function (i) { return i.connection === "Username-Password-Authentication"; });
    })[0];
    if (!u) return callback(null);
    callback(null, {
      user_id: String(u.user_id).replace(/^auth0\|/, ""),
      email: u.email,
      email_verified: !!u.email_verified,
      name: u.name,
      nickname: u.nickname,
      picture: u.picture
    });
  }).catch(function () { callback(null); });
}

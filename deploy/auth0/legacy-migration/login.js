function login(email, password, callback) {
  // Automatic migration from the old tenant (DF-19). Auth0 runs this only for people it does
  // not have yet; on success it keeps the person and their password, and never asks again.
  var base = "https://" + configuration.OLD_DOMAIN;
  fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      realm: "Username-Password-Authentication",
      username: email,
      password: password,
      client_id: configuration.OLD_PW_CLIENT_ID,
      client_secret: configuration.OLD_PW_CLIENT_SECRET,
      scope: "openid profile email"
    })
  }).then(function (res) {
    if (res.status === 401 || res.status === 403) throw new WrongUsernameOrPasswordError(email);
    if (!res.ok) throw new Error("legacy_unavailable_" + res.status);
    return res.json();
  }).then(function (tok) {
    return fetch(base + "/userinfo", { headers: { authorization: "Bearer " + tok.access_token } }).then(function (r) {
      if (!r.ok) throw new Error("legacy_userinfo_" + r.status);
      return r.json();
    });
  }).then(function (p) {
    callback(null, {
      // Same id as on the old tenant, so the person keeps the same Multies account.
      user_id: String(p.sub).replace(/^auth0\|/, ""),
      email: p.email,
      email_verified: !!p.email_verified,
      name: p.name,
      nickname: p.nickname,
      picture: p.picture
    });
  }).catch(function (err) { callback(err); });
}

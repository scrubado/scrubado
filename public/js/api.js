"use strict";
// Session-only in-memory token: no localStorage or URL query tokens.
window.ScrubadoAPI = (() => {
  let accessToken = null;
  let user = null;
  async function request(path, payload, authorized = true) {
    const headers = { "Content-Type": "application/json" };
    if (authorized) {
      if (!accessToken) throw new Error("Please sign in to calculate and save your quote.");
      headers.Authorization = `Bearer ${accessToken}`;
    }
    let response;
    try { response = await fetch(`/api${path}`, { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store" }); }
    catch { throw new Error("Could not reach Scrubado. Please try again."); }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        if (authorized) { accessToken = null; user = null; window.dispatchEvent(new Event("scrubado:session")); }
      }
      throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
    }
    return data;
  }
  return {
    login: async (email, password) => {
      const data = await request("/auth/login", {email, password}, false);
      if (!data.access_token || data.user?.role !== "customer") throw new Error("A customer account is required for quotes.");
      accessToken = data.access_token; user = data.user;
      window.dispatchEvent(new Event("scrubado:session"));
      return data;
    },
    register: (details) => request("/auth/register", details, false),
    saveQuote: (details) => request("/quotes", details),
    isSignedIn: () => !!accessToken,
    user: () => user,
    signOut: () => { accessToken = null; user = null; window.dispatchEvent(new Event("scrubado:session")); }
  };
})();

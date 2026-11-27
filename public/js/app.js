"use strict";
(() => {
 const allowed = new Set(["02067","02072","02356","02375","02766"]);
 window.ScrubadoCoverage = (zip) => allowed.has(zip);
 const year = document.getElementById("year"); if (year) year.textContent = new Date().getFullYear();
 const zipForm = document.getElementById("zip-form");
 zipForm.addEventListener("submit", (event) => {
   event.preventDefault();
   const zip = document.getElementById("zip").value.trim();
   const feedback = document.getElementById("zip-feedback");
   feedback.className = "feedback";
   if (!/^\d{5}$/.test(zip)) { feedback.textContent = "Enter a valid five-digit ZIP code."; feedback.classList.add("error"); return; }
   if (!allowed.has(zip)) { feedback.textContent = "That ZIP isn't in our initial Southern Massachusetts service area."; feedback.classList.add("error"); return; }
   feedback.textContent = "Preliminary coverage confirmed. Complete the details below to request a quote.";
   feedback.classList.add("success");
   document.getElementById("quote-zip").value = zip;
   document.getElementById("instant-quote").scrollIntoView({behavior:"smooth"});
 });
 const dialog = document.getElementById("auth-dialog"), authForm = document.getElementById("auth-form");
 const authFeedback = document.getElementById("auth-feedback");
 let registering = false;
 function open() { if (!dialog.open) dialog.showModal(); }
 document.getElementById("account-button").addEventListener("click", () => {
   if (ScrubadoAPI.isSignedIn()) { ScrubadoAPI.signOut(); } else open();
 });
 window.ScrubadoOpenLogin = open;
 document.getElementById("auth-close").addEventListener("click", () => dialog.close());
 document.getElementById("auth-switch").addEventListener("click", () => {
   registering = !registering;
   document.getElementById("register-fields").hidden = !registering;
   document.getElementById("auth-first").required = registering;
   document.getElementById("auth-last").required = registering;
   document.getElementById("auth-title").textContent = registering ? "Create customer account" : "Customer sign in";
   document.getElementById("auth-switch").textContent = registering ? "Already have an account? Sign in" : "Create an account";
   document.getElementById("auth-submit").textContent = registering ? "Register" : "Sign in";
   document.getElementById("auth-password").autocomplete = registering ? "new-password" : "current-password";
   authFeedback.textContent = "";
 });
 window.addEventListener("scrubado:session", () => {
   document.getElementById("auth-status").textContent = ScrubadoAPI.isSignedIn() ? "Signed in as customer" : "Sign in to save a quote";
   document.getElementById("account-button").textContent = ScrubadoAPI.isSignedIn() ? "Sign out" : "Sign in / Register";
 });
 authForm.addEventListener("submit", async (event) => {
   event.preventDefault(); authFeedback.textContent = "";
   const button = document.getElementById("auth-submit"); button.disabled = true;
   const email = document.getElementById("auth-email").value.trim();
   const password = document.getElementById("auth-password").value;
   try {
     if (registering) {
       await ScrubadoAPI.register({email,password,first_name:document.getElementById("auth-first").value.trim(),last_name:document.getElementById("auth-last").value.trim()});
     }
     await ScrubadoAPI.login(email,password);
     authForm.reset(); dialog.close();
   } catch (err) { authFeedback.textContent = err.message; authFeedback.className = "feedback error"; }
   finally { button.disabled = false; }
 });
})();

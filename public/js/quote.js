"use strict";
(() => {
 const form = document.getElementById("quote-form");
 const feedback = document.getElementById("quote-feedback");
 const result = document.getElementById("quote-result");
 const button = document.getElementById("quote-submit");
 const money = cents => (Number(cents) / 100).toLocaleString("en-US", {style:"currency",currency:"USD"});
 function line(label, value) {
   const row = document.createElement("div"); row.className = "quote-line";
   const name = document.createElement("span"); name.textContent = label;
   const amount = document.createElement("strong"); amount.textContent = money(value);
   row.append(name, amount); return row;
 }
 function render(data) {
   result.replaceChildren(); result.hidden = false;
   const heading = document.createElement("h3"); heading.textContent = data.status === "manual_review_required" ? "Custom quote needed" : "Your saved estimate"; result.append(heading);
   if (data.status === "manual_review_required") {
     const p = document.createElement("p"); p.textContent = data.reason || "This property requires manual review."; result.append(p); return;
   }
   if (!data.persisted || !data.quote_id || !Number.isInteger(data.amounts_cents?.customer_total)) throw new Error("Server response did not contain a saved quote.");
   const total = document.createElement("div"); total.className = "quote-price"; total.textContent = money(data.amounts_cents.customer_total); result.append(total);
   const detail = document.createElement("div"); detail.className = "quote-lines";
   const amounts = data.amounts_cents;
   detail.append(line("Service base", amounts.service_base),line("Bathrooms",amounts.bathrooms));
   if (amounts.recurring_discount) detail.append(line("Recurring discount",-amounts.recurring_discount));
   if (amounts.addons) detail.append(line("Add-ons",amounts.addons));
   if (amounts.drive) detail.append(line("Travel charge",amounts.drive));
   result.append(detail);
   const id = document.createElement("p"); id.className = "note"; id.textContent = `Quote ID: ${data.quote_id}`; result.append(id);
   if (data.expires_at) { const expires = document.createElement("p"); expires.className = "note"; expires.textContent = `Expires: ${new Date(data.expires_at).toLocaleString()}`; result.append(expires); }
   const note = document.createElement("p"); note.className = "note"; note.textContent = data.disclaimer || "Saved preliminary estimate. Booking availability must be verified."; result.append(note);
   window.dispatchEvent(new CustomEvent("scrubado:quote-saved", {detail:{quote_id:data.quote_id, postal_code:String(form.elements.postal_code.value).trim(), expires_at:data.expires_at, customer_total_cents:data.amounts_cents.customer_total}}));
 }
 form.addEventListener("submit", async (event) => {
   event.preventDefault(); window.dispatchEvent(new Event("scrubado:quote-cleared")); feedback.textContent = ""; feedback.className = "feedback"; result.hidden = true; result.replaceChildren();
   const fd = new FormData(form), postal_code = String(fd.get("postal_code")||"").trim();
   if (!window.ScrubadoCoverage(postal_code)) { feedback.textContent = "Please enter an approved Southern Massachusetts ZIP code."; feedback.classList.add("error"); return; }
   const input = {state:"MA",postal_code,service:fd.get("service"),frequency:fd.get("frequency"),sqft:Number(fd.get("sqft")),full_baths:Number(fd.get("full_baths")),half_baths:Number(fd.get("half_baths")),drive_miles:0,addons:[]};
   if (![input.sqft,input.full_baths,input.half_baths].every(Number.isSafeInteger)) { feedback.textContent = "Please enter whole numbers for property size and bathrooms."; feedback.classList.add("error"); return; }
   if (!ScrubadoAPI.isSignedIn()) { feedback.textContent = "Sign in or create a customer account first, then submit again."; window.ScrubadoOpenLogin(); return; }
   button.disabled = true; button.textContent = "Calculating…";
   try { const data = await ScrubadoAPI.saveQuote(input); render(data); feedback.textContent = data.persisted ? "Quote saved successfully." : "Quote requires manual review."; feedback.classList.add("success"); }
   catch (error) { feedback.textContent = error.message || "Quote could not be calculated."; feedback.classList.add("error"); }
   finally { button.disabled = false; button.textContent = "Calculate and save quote"; }
 });
})();

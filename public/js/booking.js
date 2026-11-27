"use strict";
(() => {
  const section = document.getElementById("booking-request");
  const form = document.getElementById("booking-form");
  const review = document.getElementById("booking-review");
  const success = document.getElementById("booking-success");
  const feedback = document.getElementById("booking-feedback");
  const confirm = document.getElementById("booking-dev-confirm");
  const submit = document.getElementById("booking-submit");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  let savedQuote = null;
  let prepared = null;
  let working = false;
  const $ = (id) => document.getElementById(id);
  function clear() {
    savedQuote = null; prepared = null;
    section.hidden = true; review.hidden = true; success.hidden = true;
    feedback.textContent = ""; confirm.checked = false; submit.disabled = true;
  }
  function status(message, error = false) {
    feedback.textContent = message;
    feedback.className = `feedback ${error ? "error" : "success"}`;
  }
  function label(parent, name, value) {
    const row = document.createElement("div"); row.className = "quote-line";
    const a = document.createElement("span"); a.textContent = name;
    const b = document.createElement("strong"); b.textContent = value;
    row.append(a,b); parent.append(row);
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function preparedData() {
    if (!savedQuote || !ScrubadoAPI.isSignedIn()) throw Error("Sign in and save a new quote first.");
    if (new Date(savedQuote.expires_at).getTime() <= Date.now()) throw Error("This quote expired. Save a new quote before requesting a booking.");
    const fd = new FormData(form);
    const body = {
      quote_id:savedQuote.quote_id,
      scheduled_date:String(fd.get("scheduled_date") || ""),
      start_time:String(fd.get("start_time") || ""),
      address_line1:String(fd.get("address_line1") || "").trim(),
      address_line2:String(fd.get("address_line2") || "").trim(),
      city:String(fd.get("city") || "").trim(),
      state:"MA",
      postal_code:String(fd.get("postal_code") || "").trim(),
      customer_notes:String(fd.get("customer_notes") || "").trim()
    };
    if (body.postal_code !== savedQuote.postal_code || !window.ScrubadoCoverage(body.postal_code)) throw Error("Address ZIP must match the saved quote.");
    if (!validDate(body.scheduled_date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.start_time)) throw Error("Enter a valid date and time.");
    if (!body.address_line1 || body.address_line1.length>200 || !body.city || body.city.length>100 || body.address_line2.length>200 || body.customer_notes.length>2000) throw Error("Please review the address and optional notes.");
    // Scheduling validity is enforced by the server in America/New_York.
    // Browser timezone must not be used to override the server's check.
    return body;
  }
  window.addEventListener("scrubado:quote-cleared", clear);
  window.addEventListener("scrubado:session", clear);
  window.addEventListener("scrubado:quote-saved", (event) => {
    clear(); const value=event.detail;
    if (!value?.quote_id || !value?.expires_at || !window.ScrubadoCoverage(value.postal_code)) return;
    savedQuote = value;
    form.reset(); $("booking-zip").value = value.postal_code;
    section.hidden = false;
    $("booking-quote-summary").textContent = `Saved quote ${value.quote_id} · ${(value.customer_total_cents/100).toLocaleString("en-US",{style:"currency",currency:"USD"})} · Expires ${new Date(value.expires_at).toLocaleString()}`;
    $("booking-dev-controls").hidden = !local;
    $("booking-prod-note").hidden = local;
    // If a quote is invalid by the time the user schedules, the server rejects it.
  });
  form.addEventListener("input", () => {
    prepared = null; review.hidden = true; confirm.checked = false; submit.disabled = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); review.hidden = true; success.hidden = true;
    try {
      prepared = preparedData();
      const details = $("booking-review-details"); details.replaceChildren();
      label(details,"Quote", prepared.quote_id);
      label(details,"Address",[prepared.address_line1,prepared.address_line2,prepared.city,prepared.state,prepared.postal_code].filter(Boolean).join(", "));
      label(details,"Requested start (Eastern)",`${prepared.scheduled_date} at ${prepared.start_time}`);
      if(prepared.customer_notes) label(details,"Notes",prepared.customer_notes);
      confirm.checked = false; submit.disabled = true;
      review.hidden = false;
      status(local ? "Review the request below. Local testing is optional." : "Booking preview ready. Live submissions are disabled.");
      review.scrollIntoView({behavior:"smooth",block:"nearest"});
    } catch (err) { prepared=null; status(err.message,true); }
  });
  confirm.addEventListener("change", () => { submit.disabled = !confirm.checked || !prepared || working; });
  submit.addEventListener("click", async () => {
    if (!local || !confirm.checked || !prepared || working) return;
    working=true; submit.disabled=true; submit.textContent="Submitting local test…";
    try {
      // Re-read and compare the exact reviewed payload before submission.
      const current = preparedData();
      if(JSON.stringify(current)!==JSON.stringify(prepared)) throw Error("Your details changed. Review the request again.");
      const data = await ScrubadoAPI.createBooking(current);
      if(data?.status!=="created" || !data?.booking?.id) throw Error("Unexpected booking response.");
      success.replaceChildren();
      const h=document.createElement("h3"); h.textContent="Development booking request created";
      const p=document.createElement("p"); p.textContent=`Booking ID: ${data.booking.id} · Status: ${data.booking.status}. No cleaner assigned and no payment charged.`;
      const note=document.createElement("p"); note.className="note"; note.textContent=data.disclaimer || "Development-only booking; verification pending.";
      success.append(h,p,note); success.hidden=false; review.hidden=true;
      savedQuote=null; prepared=null;
      status("Local test booking saved. Your quote is now used.");
    } catch(err) { status(err.message || "Booking request failed.",true); }
    finally { working=false; submit.textContent="Submit LOCAL test request"; submit.disabled=true; confirm.checked=false; }
  });
})();

export const REPORT = Object.freeze({
  reproduction_steps: ["Send an unauthenticated request to the synthetic export endpoint.", "Read the response and compare its customer rows with the fixture."],
  attacker_capability: "An unauthenticated attacker can retrieve private customer records.",
  observed_result: "The synthetic response returned customer records without authentication.",
  harm: "Private customer data was disclosed in the fixture. Real deployment impact requires confirmation.",
  limitations: "This is a synthetic captured-response test. No external service was accessed.",
});

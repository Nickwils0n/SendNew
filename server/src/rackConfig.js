// One rack, one 32-port switch -- see dmg-build/README.md. Shared between
// admin.js (the CRM's rack console) and agentAuth.js (a device setting its
// own bay/port) so the two can never drift apart. Generalize only if a
// second rack is actually bought.
module.exports = { RACK_BAYS: 20, SWITCH_PORTS: 32 };

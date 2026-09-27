// Per-compilation bridges are released when webpack closes. Nothing is global
// in the generated application or retained by the production server.
exports.active = new Map();

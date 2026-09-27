'use strict';
const DYNAMIC_BAILOUT = 'BAILOUT_TO_CLIENT_SIDE_RENDERING';

class DynamicBailout extends Error {
  constructor() {
    super('Bail out to client-side rendering: next/dynamic');
    this.digest = DYNAMIC_BAILOUT;
  }
}

function isDynamicBailout(error) { return error?.digest === DYNAMIC_BAILOUT; }

module.exports = { DynamicBailout, isDynamicBailout };

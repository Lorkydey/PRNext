'use strict';

// Shell validation is separate: these options only control navigation probes.
function instantEnabled(config, production) {
  if (config === false) return false;
  if (config && typeof config === 'object') {
    if (config.unstable_disableValidation || (production ? config.unstable_disableBuildValidation : config.unstable_disableDevValidation)) return false;
    return !production || config.level === 'experimental-error';
  }
  return !production;
}

module.exports = { instantEnabled };

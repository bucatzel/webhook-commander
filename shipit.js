
var config = require('./config.json');

module.exports = function (shipit) {
  require('shipit-deploy')(shipit);

  shipit.initConfig(config.shipit.config);

};

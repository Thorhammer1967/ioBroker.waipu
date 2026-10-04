const path = require("path");
const { tests } = require("@iobroker/testing");

// Validate the package files (package.json, io-package.json, README, LICENSE, icon ...)
tests.packageFiles(path.join(__dirname, ".."));
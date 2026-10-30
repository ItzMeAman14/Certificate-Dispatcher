'use strict';

/** An error that is safe to show to the user. `code` lets the UI react (e.g. NO_CONNECTION). */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
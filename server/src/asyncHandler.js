// Express doesn't forward a rejected promise from an async route handler to
// its error middleware — it becomes an unhandled rejection, which Node
// terminates the whole process for by default (Node >=15). Wrapping every
// async handler with this ensures one bad request can't take the server down
// for every other company/device connected to it.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };

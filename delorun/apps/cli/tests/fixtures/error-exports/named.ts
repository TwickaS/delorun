/**
 * Error classes exported through an export list, one under another name, as the refusal gate's fixture: a class that
 * extends `Error`, a class that extends it without a name ending in `Error`, and a class that is no error.
 */

/** An error class exported by name through the export list. */
class NamedFixtureError extends Error {}

/** An error class through its base class, exported under another name. */
class FixtureFailure extends NamedFixtureError {}

/** A class that is no error. */
class NotAFailure {}

export { NamedFixtureError, FixtureFailure as RenamedFixtureFailure, NotAFailure }

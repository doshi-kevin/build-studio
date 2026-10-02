/** Errors from the check worker. Pure, so tools can recognise them without importing the worker. */

/** The check ran out of time or memory, or the worker died. The run ends failed (check_timeout). */
export class CheckTimeout extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CheckTimeout'
  }
}

/** The compiler broke its own contract. The run ends failed (internal). */
export class CheckFault extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CheckFault'
  }
}

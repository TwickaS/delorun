/**
 * The seat leases and the "for this run" rules beside them: one table in this process's memory, keyed by the seat
 * child, that nothing writes to disk (EA15, EA21). A lease ends with its rules, and every end is told to the listeners,
 * so the start gate stops that child's program.
 *
 * @module @delorun/plugin-delegation-consent/leases
 */
import type { ProgramRunRule, SeatLease, SeatLeaseEnd, SessionId } from '@delorun/external-agents/contract'

/** One child's lease and the rules kept beside it. */
interface Held {
  readonly lease: SeatLease
  readonly rules: ProgramRunRule[]
}

/** The listener a lease end is told to. */
export type LeaseEndListener = (lease: SeatLease, reason: SeatLeaseEnd) => void

/** The in-memory lease table. */
export class SeatLeases {
  private readonly held = new Map<SessionId, Held>()
  private readonly listeners = new Set<LeaseEndListener>()
  private readonly report: (error: unknown) => void

  /** @param report - where a listener's failure is reported; it never stops the other listeners. */
  constructor(report: (error: unknown) => void) {
    this.report = report
  }

  /**
   * The child's lease.
   * @param child - the seat child.
   * @returns the lease, or undefined.
   */
  leaseOf(child: SessionId): SeatLease | undefined {
    return this.held.get(child)?.lease
  }

  /**
   * Record a lease, replacing the child's earlier one and its rules without telling the listeners: the program that
   * runs under it was allowed by the new review.
   * @param lease - the lease.
   */
  record(lease: SeatLease): void {
    this.held.set(lease.child, { lease, rules: [] })
  }

  /**
   * End one child's lease and its rules.
   * @param child - the seat child.
   * @param reason - why.
   */
  end(child: SessionId, reason: SeatLeaseEnd): void {
    const held = this.held.get(child)
    if (held === undefined) return
    this.held.delete(child)
    this.tell(held.lease, reason)
  }

  /**
   * End every lease that matches.
   * @param matches - which leases end.
   * @param reason - why.
   */
  endWhere(matches: (lease: SeatLease) => boolean, reason: SeatLeaseEnd): void {
    for (const held of [...this.held.values()]) {
      if (matches(held.lease)) this.end(held.lease.child, reason)
    }
  }

  /**
   * The child's run rules.
   * @param child - the seat child.
   * @returns the rules, oldest first.
   */
  rulesOf(child: SessionId): readonly ProgramRunRule[] {
    return [...this.held.get(child)?.rules ?? []]
  }

  /**
   * Keep one rule beside the child's lease.
   * @param child - the seat child.
   * @param rule - the rule.
   * @returns false when the child has no lease.
   */
  addRule(child: SessionId, rule: ProgramRunRule): boolean {
    const held = this.held.get(child)
    if (held === undefined) return false
    held.rules.push(rule)
    return true
  }

  /**
   * Hear every lease end.
   * @param listener - the listener.
   * @returns the disposer.
   */
  listen(listener: LeaseEndListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Tell every listener about one end.
   * @param lease - the ended lease.
   * @param reason - why.
   */
  private tell(lease: SeatLease, reason: SeatLeaseEnd): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(lease, reason)
      } catch (error) {
        this.report(error)
      }
    }
  }
}

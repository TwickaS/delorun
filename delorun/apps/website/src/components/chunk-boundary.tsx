/**
 * The guard around a part of a page whose script loads as its own chunk. If the chunk fails to load (a dropped
 * connection, or a tab left open across a deploy that removed the old file), only that part gives way to its fallback;
 * the rest of the page stays.
 *
 * @module @delorun/website/chunk-boundary
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

/** The props of {@link ChunkBoundary}. */
interface ChunkBoundaryProps {
  /** What stands in the part's place once its chunk has failed. */
  readonly fallback: ReactNode
  readonly children: ReactNode
}

/** Renders its children, or its fallback once rendering them has failed. */
export class ChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  /**
   * Switches to the fallback after a failure below.
   * @returns the new state.
   */
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  /**
   * Reports the failure in the console, where a visitor's report can name it.
   * @param error - the failure.
   * @param info - where it happened.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('A part of the page did not load.', error, info.componentStack)
  }

  /**
   * The part, or its fallback.
   * @returns the children or the fallback.
   */
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

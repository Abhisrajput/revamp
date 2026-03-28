/**
 * Shared types for cloud architecture diagram components.
 */

export interface CloudService {
  id: string;
  name: string;
  /** Service type used to pick the icon / placement in the diagram */
  type: string;
  /** Optional description shown on hover or below the service */
  description?: string;
  /** Connection targets (ids of other services this one connects to) */
  connections?: string[];
}

export interface ArchitectureDiagramProps {
  /** Services discovered or recommended by the AI output */
  services: CloudService[];
  /** Optional CSS class */
  className?: string;
  /** Optional title override */
  title?: string;
}

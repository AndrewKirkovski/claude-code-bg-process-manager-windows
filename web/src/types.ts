export interface ProcessWithStatus {
  id: number
  name: string
  project: string
  pid: number
  command: string
  intent: string
  log_file: string
  started_at: string
  cwd: string
  env_vars: string | null
  alive: boolean
  triggers: {
    config: {
      notifyDead?: boolean
      notifyPort?: boolean
      notifyReady?: boolean
      logTriggers?: { pattern: string; once?: boolean }[]
    }
    state: {
      firedDead: boolean
      firedReady: boolean
      firedPorts: string[]
      firedLogOnce: string[]
    }
  } | null
}

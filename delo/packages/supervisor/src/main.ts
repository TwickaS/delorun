/**
 * The supervisor process's entry module, which the home process spawns with the launch pipe on file descriptor 3
 * (`./launch.ts`).
 *
 * @module @delo/supervisor/main
 */
import { runSupervisorProcess } from './launch.ts'

await runSupervisorProcess()

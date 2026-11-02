import type { FlowEndSummary } from '../components/ActionFlowVisualization'
import type { MemoryWorkerErrorDiagnosis } from '../services/memoryWorkerApi'
import type { SubtaskCardMetrics } from './subtaskMetrics'

export function buildFlowEndSummary(
  metrics: Pick<
    SubtaskCardMetrics,
    | 'readFilesCount'
    | 'readFilePaths'
    | 'globMatchFileCount'
    | 'webSearchCallCount'
    | 'webSearchQueries'
    | 'mutatedFileCount'
    | 'mutatedFilePaths'
  >,
  errorDiagnosis?: MemoryWorkerErrorDiagnosis,
): FlowEndSummary {
  return {
    readFileTotalCount: metrics.readFilesCount,
    readFilePaths: metrics.readFilePaths,
    globMatchFileCount: metrics.globMatchFileCount,
    webSearchCount: metrics.webSearchCallCount,
    webSearchQueries: metrics.webSearchQueries,
    writeFileCount: metrics.mutatedFileCount,
    changedFilePaths: metrics.mutatedFilePaths,
    errorDiagnosis,
  }
}

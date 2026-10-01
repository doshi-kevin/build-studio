// Shared pure functions for topic-level accuracy calculation.
// Reused by both professor (class-level) and student (individual) analytics.

export interface SkillInsight {
  tag: string
  correctCount: number
  totalCount: number
  accuracy: number // 0-100
  questionCount: number // unique questions with this tag
}

export interface SkillPerformanceResult {
  topics: SkillInsight[]
  strengths: string[] // tags with accuracy >= 80%
  weaknesses: string[] // tags with accuracy < 50%
}

/**
 * Calculate topic-level accuracy from answer data joined with question tags.
 * Each answer is associated with question tags; we aggregate correctness per tag.
 */
export function calculateSkillInsights(
  answers: { questionId: string; isCorrect: boolean }[],
  questionTags: Record<string, string[]> // questionId → tags[]
): SkillPerformanceResult {
  const tagStats: Record<string, { correct: number; total: number; questionIds: Set<string> }> = {}

  for (const answer of answers) {
    const tags = questionTags[answer.questionId] ?? []
    for (const tag of tags) {
      if (!tagStats[tag]) {
        tagStats[tag] = { correct: 0, total: 0, questionIds: new Set() }
      }
      tagStats[tag].total += 1
      tagStats[tag].questionIds.add(answer.questionId)
      if (answer.isCorrect) tagStats[tag].correct += 1
    }
  }

  const topics: SkillInsight[] = Object.entries(tagStats)
    .map(([tag, stats]) => ({
      tag,
      correctCount: stats.correct,
      totalCount: stats.total,
      accuracy: stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0,
      questionCount: stats.questionIds.size,
    }))
    .sort((a, b) => b.totalCount - a.totalCount) // most-answered topics first

  const strengths = topics.filter((t) => t.accuracy >= 80).map((t) => t.tag)
  const weaknesses = topics.filter((t) => t.accuracy < 50).map((t) => t.tag)

  return { topics, strengths, weaknesses }
}

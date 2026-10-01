/**
 * Notebook templates: editable scaffolds, NOT hardcoded layouts.
 *
 * A template is just a function that builds a fresh StudioNotebook (an ordered set of
 * default cells). Once instantiated it's a normal notebook: the professor, the ribbon,
 * and (later) the Athena seam edit it freely. Pure + server-safe (no React/lucide) so a
 * server action can build one on assignment create.
 */
import { type StudioNotebook, type StudioCell, emptyNotebook, genCellId } from './notebook-model'
import { setAuthoring, type AuthoringMeta } from './authoring'

function md(source: string): StudioCell {
  return { id: genCellId(), cell_type: 'markdown', source, metadata: {}, outputs: [], execution_count: null }
}
function code(source: string): StudioCell {
  return { id: genCellId(), cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null }
}
/** Markdown cell carrying shared authoring metadata (points, answer key, etc.). */
function problem(source: string, authoring: AuthoringMeta): StudioCell {
  return { ...md(source), metadata: setAuthoring({}, authoring) }
}

function notebookWith(cells: StudioCell[]): StudioNotebook {
  return { ...emptyNotebook(), cells }
}

/** ML Assignment: Question → Starter Code → Student Work → Analysis → Conclusion.
 *  Pre-filled with example tables, math blocks and symbols the professor can edit. */
function buildMlAssignment(): StudioNotebook {
  return notebookWith([
    md(`# ML Assignment

## Question
Train a model to predict the target from the features below, then minimise the error.

| Feature | Type | Description |
| --- | --- | --- |
| area | numeric | floor area (m²) |
| rooms | numeric | number of rooms |
| price | target | sale price (USD) |

**Objective.** Minimise the mean squared error:

$$\\mathrm{MSE} = \\frac{1}{n}\\sum_{i=1}^{n}\\left(y_i - \\hat{y}_i\\right)^2$$

Symbols you may need: learning rate $\\alpha$, gradient $\\nabla L$, parameters $\\theta$.`),
    md('## Starter Code\n\nProvided scaffolding students build on.'),
    code('import numpy as np\nimport pandas as pd\n\n# Starter helpers provided for students\ndef load_data(path):\n    return pd.read_csv(path)'),
    md('## Your Work\n\nComplete the implementation below.'),
    code('# YOUR CODE HERE\nraise NotImplementedError'),
    md(`## Analysis
Report your results in the table and comment on them.

| Model | RMSE | $R^2$ |
| --- | --- | --- |
| Baseline |  |  |
| Yours |  |  |`),
    code('# Analysis / evaluation code'),
    md('## Conclusion\n\nSummarise what you found and what you would try next.'),
  ])
}

/** Data Science: Title → Dataset → Objectives → Imports → EDA → Visualization → Training → Evaluation → Conclusion.
 *  Pre-filled with example tables, math, units and chemistry the professor can edit. */
function buildDataScience(): StudioNotebook {
  return notebookWith([
    md('# Data Science Project\n\n_Replace with your project title._'),
    md(`## Dataset

| Column | Type | Notes |
| --- | --- | --- |
| date | datetime | daily records |
| sales | numeric | target variable |
| promo | boolean | promotion active |
`),
    md(`## Objectives

- Explore and clean the data
- Model $\\hat{y} = f(\\mathbf{x})$ and report $R^2$
- Correlation: $\\rho_{X,Y} = \\dfrac{\\operatorname{cov}(X,Y)}{\\sigma_X\\,\\sigma_Y}$`),
    md('## Imports'),
    code('import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt'),
    md('## Exploratory Data Analysis'),
    code('# df = pd.read_csv("data.csv")\n# df.describe()'),
    md(`## Visualization

Label axes with units where relevant, e.g. concentration $\\pu{0.5 mol/L}$, or annotate a reaction such as $\\ce{2H2 + O2 -> 2H2O}$.`),
    code('# plt.figure(figsize=(8, 5))\n# ...\n# plt.show()'),
    md('## Training'),
    code('# Fit your model here'),
    md('## Evaluation'),
    code('# Report metrics here'),
    md('## Conclusion\n\nKey findings and next steps.'),
  ])
}

/** Blank: a single EMPTY markdown cell so the canvas opens ready to type, not void. The cell
 *  source is empty on purpose: the editor shows its own "Empty text block. Click to edit." hint
 *  (UI only, never saved), so a professor who publishes without editing doesn't leak authoring
 *  scaffolding like "add blocks from the palette" to students (#329). */
function buildBlank(): StudioNotebook {
  return notebookWith([md('')])
}

/** A ready-made question: the markdown prompt plus the professor-only answer key and points. */
interface ReadyProblem {
  source: string
  answerKey: string
  points?: number
}

/** Clamp a professor-chosen question count to a sane range (fall back when unset). */
function clampCount(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return fallback
  return Math.max(1, Math.min(20, Math.floor(n)))
}

/** Build a STEM subject problem set: an intro cell followed by exactly `questionCount` markdown
 *  cells, one per question. Cells are seeded from the ready-made bank first; beyond the bank the
 *  subject `scaffold` pre-fills the relevant formulas / diagram prompts so the professor only has
 *  to write the question. Each cell ends with a response area (used in the student view + PDF). */
function buildSubject(title: string, intro: string, bank: ReadyProblem[], scaffold: (n: number) => string, solverExamples?: string) {
  return (opts?: BuildOptions): StudioNotebook => {
    const count = clampCount(opts?.questionCount, bank.length || 3)
    const introText = solverExamples ? `${intro}${SOLVER_HOWTO}` : intro
    const cells: StudioCell[] = [md(`# ${title}\n\n${introText}`)]
    // Maths/physics: a ready-to-use "try the tools" cell right after the intro.
    if (solverExamples) cells.push(md(solverExamples))
    for (let i = 0; i < count; i++) {
      const ready = bank[i]
      const body = ready ? ready.source : scaffold(i + 1)
      cells.push(problem(`${body}\n\n**Your working and final answer:**\n`, { points: ready?.points ?? 5, answerKey: ready?.answerKey ?? '' }))
    }
    return notebookWith(cells)
  }
}

/** Per-subject scaffold for questions beyond the ready-made bank: a heading, a prompt to write the
 *  question, and the formulas / graph placeholders relevant to that subject already filled in. */
function stemScaffold(subject: string, formulas: string): (n: number) => string {
  return (n) => `## Problem ${n} — ${subject}\n\n_Write the problem here._\n\n${formulas}`
}

const MATH_INTRO = 'Each question is a block below. Show your working, then write the final answer in the response area. Math uses LaTeX: $x^2$ inline, $$…$$ block.'
const SCIENCE_INTRO = 'Each question is a block below. Show your working, then write the final answer in the response area. LaTeX ($x^2$, $$…$$), chemistry \\ce{…}, and units \\pu{…} are supported.'

const MATHS_SCAFFOLD = stemScaffold('Maths', 'Useful formulas:\n\n$$\\frac{d}{dx}x^{n} = n x^{n-1} \\qquad \\int x^{n}\\,dx = \\frac{x^{n+1}}{n+1} + C \\qquad x = \\frac{-b \\pm \\sqrt{b^{2}-4ac}}{2a}$$\n\n_Sketch or insert a graph if it helps._')
const PHYSICS_SCAFFOLD = stemScaffold('Physics', 'Useful formulas:\n\n$$v = u + at \\qquad s = ut + \\tfrac{1}{2}at^{2} \\qquad F = ma \\qquad E_k = \\tfrac{1}{2}mv^{2}$$\n\n_Insert a diagram or graph if relevant._')
const CHEMISTRY_SCAFFOLD = stemScaffold('Chemistry', 'Useful relations (use \\ce{…} for equations):\n\n$$\\ce{aA + bB -> cC + dD} \\qquad c = \\frac{n}{V} \\qquad n = \\frac{m}{M}$$')
const BIOLOGY_SCAFFOLD = stemScaffold('Biology', '_Insert a labelled diagram if relevant, and define the key terms you use._')
const BLANK_SCAFFOLD = (n: number) => `## Problem ${n}\n\n_Write the question here. LaTeX ($x^2$, $$…$$), chemistry \\ce{…}, and units \\pu{…} are supported._`

// Maths/physics only: a how-to line appended to the intro, plus a "try it" block of example
// queries. The Solver lives in the side toolkit and generates solutions into the selected block.
const SOLVER_HOWTO = '\n\n**Solver:** open the **Solver** in the side toolkit, type an expression, and pick a tool (Answer, Worked solution, Simplify, Physics, Plot, Result image). Preview the result, then add it to the selected block or keep it in the answer key.'

const MATHS_SOLVER_EXAMPLES = `## Try the Solver

Select this block, open the **Solver** in the side toolkit, type the expression, and pick the tool:

- **Answer** → \`integrate x^2 from 0 to 1\`
- **Worked solution** → \`derivative of sin(x)*e^x\`
- **Simplify** → \`(x^2-1)/(x-1)\`
- **Plot** → \`plot x^2 from -3 to 3\`
- **Result image** → \`solve x^2-5x+6=0\`

Choose "Add to block" to insert the result here, or "Save to answer key" to keep it for yourself.`

const PHYSICS_SOLVER_EXAMPLES = `## Try the Solver

Select this block, open the **Solver** in the side toolkit, type the expression, and pick the tool:

- **Physics** → \`kinetic energy of 2 kg at 3 m/s\`
- **Answer** → \`speed of light in km/s\`
- **Worked solution** → \`projectile range v=20 m/s angle=30 deg\`
- **Plot** → \`plot sin(x) from 0 to 2 pi\`
- **Result image** → \`force = 2 kg * 3 m/s^2\`

Choose "Add to block" to insert the result here, or "Save to answer key" to keep it for yourself.`

const MATHS_BANK: ReadyProblem[] = [
  { source: `## Problem 1 — Calculus

Evaluate the definite integral and state the area it represents:

$$\\int_{0}^{1} x^{2} \\, dx$$

Then differentiate $f(x) = \\sin x \\cdot e^{x}$.`, answerKey: 'Integral = 1/3 (area under x² on [0,1]). f\'(x) = e^x(sin x + cos x).' },
  { source: `## Problem 2 — Algebra

Solve the quadratic equation:

$$x^{2} - 5x + 6 = 0$$

State both roots.`, answerKey: 'Factor (x-2)(x-3)=0 → x = 2 or x = 3.' },
  { source: `## Problem 3 — Trigonometry

Prove the identity for all $\\theta$ where it is defined:

$$\\sin^{2}\\theta + \\cos^{2}\\theta = 1$$

Then find all solutions of $2\\sin\\theta = 1$ in $[0, 2\\pi)$.`, answerKey: 'Pythagorean identity from the unit circle. 2 sin θ = 1 → θ = π/6 or 5π/6.' },
]

const PHYSICS_BANK: ReadyProblem[] = [
  { source: `## Problem 1 — Kinematics

A ball is thrown straight up at $u = \\pu{20 m/s}$. Take $g = \\pu{9.8 m/s^2}$.

1. How long does it take to reach the highest point?
2. What is the maximum height?

$$v = u + at \\qquad s = ut + \\tfrac{1}{2}at^{2}$$`, answerKey: 't = u/g ≈ 2.04 s; max height = u²/(2g) ≈ 20.4 m.' },
  { source: `## Problem 2 — Dynamics

A $\\pu{2 kg}$ block on a frictionless surface is pushed with a horizontal force $F = \\pu{10 N}$.

1. Find its acceleration.
2. If instead the coefficient of kinetic friction is $\\mu = 0.20$, find the new acceleration.

$$F_{net} = ma \\qquad f = \\mu m g$$`, answerKey: 'a = F/m = 5 m/s². With friction: f = μmg = 3.92 N, a = (10−3.92)/2 ≈ 3.04 m/s².' },
  { source: `## Problem 3 — Energy

A $\\pu{0.5 kg}$ ball is dropped from rest at a height of $\\pu{10 m}$. Ignoring air resistance, find its speed just before it hits the ground.

$$mgh = \\tfrac{1}{2}mv^{2}$$`, answerKey: 'v = √(2gh) = √(2·9.8·10) ≈ 14 m/s.' },
]

const CHEMISTRY_BANK: ReadyProblem[] = [
  { source: `## Problem 1 — Stoichiometry

Consider the combustion of hydrogen:

$$\\ce{2H2 + O2 -> 2H2O}$$

Starting from $\\pu{4 mol}$ of $\\ce{H2}$, how many moles of $\\ce{H2O}$ are produced, and what volume of $\\ce{O2}$ is consumed at STP ($\\pu{22.4 L/mol}$)?`, answerKey: '4 mol H2 → 4 mol H2O; 2 mol O2 consumed = 44.8 L at STP.' },
  { source: `## Problem 2 — Concentration

$\\pu{0.25 mol}$ of $\\ce{NaCl}$ is dissolved in water and made up to $\\pu{500 mL}$ of solution. Find the molarity.

$$c = \\frac{n}{V}$$`, answerKey: 'c = 0.25 mol / 0.500 L = 0.50 mol/L.' },
  { source: `## Problem 3 — Acid–Base

Write the balanced neutralisation reaction between hydrochloric acid and sodium hydroxide, and state the volume of $\\pu{0.10 mol/L}$ $\\ce{NaOH}$ needed to neutralise $\\pu{25 mL}$ of $\\pu{0.10 mol/L}$ $\\ce{HCl}$.`, answerKey: '\\ce{HCl + NaOH -> NaCl + H2O}. Equal moles → 25 mL of NaOH.' },
]

const BIOLOGY_BANK: ReadyProblem[] = [
  { source: `## Problem 1 — Genetics

In pea plants, tall (T) is dominant over short (t). Cross two heterozygous plants ($Tt \\times Tt$).

1. Draw the Punnett square.
2. State the genotype and phenotype ratios of the offspring.`, answerKey: 'Genotype 1 TT : 2 Tt : 1 tt. Phenotype 3 tall : 1 short.' },
  { source: `## Problem 2 — Cell Biology

Write the overall balanced equation for photosynthesis and name the organelle where it occurs.

$$\\ce{6CO2 + 6H2O -> C6H12O6 + 6O2}$$`, answerKey: 'Occurs in the chloroplast; light energy drives the reaction shown.' },
  { source: `## Problem 3 — Physiology

Explain how the structure of an alveolus is adapted for efficient gas exchange (give at least three adaptations).`, answerKey: 'Large surface area, thin (one-cell) walls for short diffusion distance, rich capillary network / good blood supply, moist lining.' },
]

export interface BuildOptions {
  /** STEM subject templates: how many question blocks to seed. Ignored by other templates. */
  questionCount?: number
}

export interface NotebookTemplate {
  id: string
  title: string
  description: string
  build: (opts?: BuildOptions) => StudioNotebook
}

export const NOTEBOOK_TEMPLATES: NotebookTemplate[] = [
  {
    id: 'blank',
    title: 'Blank Notebook',
    description: 'Start from an empty notebook and build it block by block.',
    build: buildBlank,
  },
  {
    id: 'ml-assignment',
    title: 'ML Assignment',
    description: 'Question, starter code, student work, analysis, and conclusion blocks.',
    build: buildMlAssignment,
  },
  {
    id: 'data-science',
    title: 'Data Science',
    description: 'Dataset, objectives, imports, EDA, visualization, training, evaluation.',
    build: buildDataScience,
  },
]

/** STEM Problem Set subjects, shown in their own picker (reached from the STEM entry card).
 *  Each builds `questionCount` equation-rich problem blocks, seeded from a ready-made bank. */
export const STEM_TEMPLATES: NotebookTemplate[] = [
  {
    id: 'stem-maths',
    title: 'Maths',
    description: 'Algebra, calculus and trigonometry problems in LaTeX, with points and answer keys.',
    build: buildSubject('Maths Problem Set', MATH_INTRO, MATHS_BANK, MATHS_SCAFFOLD, MATHS_SOLVER_EXAMPLES),
  },
  {
    id: 'stem-physics',
    title: 'Physics',
    description: 'Kinematics, dynamics and energy problems with equations, points and answer keys.',
    build: buildSubject('Physics Problem Set', SCIENCE_INTRO, PHYSICS_BANK, PHYSICS_SCAFFOLD, PHYSICS_SOLVER_EXAMPLES),
  },
  {
    id: 'stem-chemistry',
    title: 'Chemistry',
    description: 'Stoichiometry, concentration and acid–base problems with \\ce{…} equations and answer keys.',
    build: buildSubject('Chemistry Problem Set', SCIENCE_INTRO, CHEMISTRY_BANK, CHEMISTRY_SCAFFOLD),
  },
  {
    id: 'stem-biology',
    title: 'Biology',
    description: 'Genetics, cell biology and physiology problems, with points and answer keys.',
    build: buildSubject('Biology Problem Set', SCIENCE_INTRO, BIOLOGY_BANK, BIOLOGY_SCAFFOLD),
  },
  {
    id: 'stem-blank',
    title: 'Blank',
    description: 'Empty problem blocks to write your own STEM questions.',
    build: buildSubject('STEM Problem Set', SCIENCE_INTRO, [], BLANK_SCAFFOLD),
  },
]

const ALL_TEMPLATES = [...NOTEBOOK_TEMPLATES, ...STEM_TEMPLATES]

export function getNotebookTemplate(id: string): NotebookTemplate | undefined {
  return ALL_TEMPLATES.find((t) => t.id === id)
}

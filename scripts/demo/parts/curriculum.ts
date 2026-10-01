// The course content itself, in one place: fifteen weeks of Applied Machine
// Learning. Modules, lecture decks, quiz questions, skills and the roadmap all
// read from here, so a topic renamed once is renamed everywhere and the demo
// never contradicts itself across screens.

export interface Week {
  n: number
  topic: string
  blurb: string
  /** Skill names taught this week. These become `skills` rows and mastery targets. */
  skills: string[]
  /** Slide headings + bullets for the week's live-classroom deck. */
  slides: Array<{ heading: string; bullets: string[] }>
  /** What the professor actually said, per slide — becomes lc_transcriptions. */
  transcript: string[]
}

export const WEEKS: Week[] = [
  {
    n: 1,
    topic: 'What machine learning can and cannot do',
    blurb: 'Supervised learning as function approximation, and the questions ML is the wrong tool for.',
    skills: ['Problem Framing', 'Supervised vs Unsupervised'],
    slides: [
      { heading: 'Why this course exists', bullets: ['Most ML failures are framing failures, not model failures', 'A model is a compressed summary of the data you gave it', 'If you cannot state the decision it supports, stop'] },
      { heading: 'Supervised learning', bullets: ['You have inputs X and labels y', 'You want f such that f(X) approximates y on data you have never seen', 'Everything else this semester is detail'] },
      { heading: 'When ML is the wrong tool', bullets: ['The rule is already known and writable', 'Labels do not exist and cannot be collected', 'A wrong answer is unacceptable and unreviewable'] },
      { heading: 'The shape of a project', bullets: ['Frame the decision', 'Assemble and split the data', 'Establish a baseline', 'Improve against the baseline, honestly'] },
      { heading: 'Course mechanics', bullets: ['Five homeworks, lowest dropped', 'Weekly quizzes, best four count', 'Team project in the second half'] },
    ],
    transcript: [
      'Welcome to CS 340. I want to start somewhere slightly unusual, which is with the cases where machine learning is the wrong answer, because in my experience that is where most of the wasted effort in industry goes.',
      'Supervised learning, formally, is function approximation. You are handed pairs of inputs and labels and asked to produce a function that generalises. That is the whole game. Every technique we cover is a different bet about what kind of function is plausible.',
      'So when is it wrong? Three cases. One, the rule is already known. If your legal team can write the rule, write the rule. Two, you have no labels and no way to get them. Three, the cost of a wrong answer is high and nobody will review the output.',
      'The shape of a project is the same every time. Frame the decision first. Then split your data before you look at it. Then get a baseline, something embarrassingly simple, because you cannot claim improvement without it.',
      'Mechanics quickly. Five homeworks and I drop your lowest. Weekly quizzes, best four of five. Do not email me asking for a sixth quiz.',
    ],
  },
  {
    n: 2,
    topic: 'Data, features, and leakage',
    blurb: 'Train/validation/test discipline, and the ways information sneaks across the split.',
    skills: ['Train/Test Splitting', 'Data Leakage', 'Feature Construction'],
    slides: [
      { heading: 'The split is the experiment', bullets: ['Test data is a one-time measurement', 'Validation is for choosing; test is for reporting', 'If you tuned on it, it is not test data any more'] },
      { heading: 'Leakage', bullets: ['Any information about y that would not exist at prediction time', 'Scaling before splitting is leakage', 'Target encoding computed on the full set is leakage'] },
      { heading: 'Temporal data', bullets: ['Random splits on time series are always wrong', 'Split forward in time, predict forward in time', 'Backtest the way you would deploy'] },
      { heading: 'Feature construction', bullets: ['Features encode what you believe matters', 'Ratios and differences often beat raw columns', 'Every feature needs a story about availability'] },
      { heading: 'Missing values', bullets: ['Missingness is itself a signal', 'Impute inside the pipeline, never before the split', 'Record the imputation as part of the model'] },
    ],
    transcript: [
      'Today is the most boring lecture of the semester and the one that decides whether your project works. It is about the split.',
      'Your test set is a one-time measurement. The moment you look at it and change something, it becomes validation data and you no longer have a test set. People break this rule constantly and then wonder why production performance disagrees with the notebook.',
      'Leakage is any information about the label that would not be available at prediction time. The classic one is scaling. If you fit your scaler on the whole dataset and then split, the mean of your test set has leaked into training.',
      'For anything with a time dimension, a random split is simply invalid. You are training on the future and predicting the past. Split forward in time.',
      'Feature construction is where domain knowledge enters. Ratios and differences carry more signal than the raw columns more often than you would think.',
      'Last thing: missingness is a signal. Whether a field is blank often tells you more than what is in it.',
    ],
  },
  {
    n: 3,
    topic: 'Linear regression and regularization',
    blurb: 'Least squares, the bias-variance trade, and what ridge and lasso actually do.',
    skills: ['Linear Regression', 'Regularization', 'Bias-Variance Tradeoff'],
    slides: [
      { heading: 'Least squares', bullets: ['Minimise the sum of squared residuals', 'Closed form exists; gradient descent scales better', 'Squared error assumes symmetric, Gaussian-ish noise'] },
      { heading: 'Bias and variance', bullets: ['Bias: wrong on average, even with infinite data', 'Variance: answer swings with the sample you drew', 'Total error is the sum; you trade one for the other'] },
      { heading: 'Ridge', bullets: ['Penalise the sum of squared coefficients', 'Shrinks everything, zeroes nothing', 'Handles correlated predictors gracefully'] },
      { heading: 'Lasso', bullets: ['Penalise the sum of absolute coefficients', 'Drives some coefficients exactly to zero', 'Selection and fitting in one step'] },
      { heading: 'Choosing lambda', bullets: ['Cross-validate, never eyeball', 'The best lambda depends on your sample size', 'Report the curve, not just the winner'] },
    ],
    transcript: [
      'Linear regression. Everyone thinks they know it, and then half the class gets the regularization question wrong on the midterm, so pay attention.',
      'Least squares minimises the sum of squared residuals. There is a closed form solution. On any dataset that fits in memory you can just use it. Squared error is a modelling choice though, and it assumes your errors are roughly symmetric.',
      'The bias-variance decomposition is the reason this course exists. Bias is being wrong on average. Variance is your answer moving around depending on which sample you happened to draw. You almost always trade one against the other.',
      'Ridge penalises the sum of squared coefficients. It shrinks everything toward zero but never quite gets there. It is very well behaved when predictors are correlated.',
      'Lasso penalises absolute values, and the geometry of that penalty means some coefficients land exactly on zero. So it selects features while it fits.',
      'Choose lambda with cross-validation. And show me the whole curve in your writeup, not just the number you liked.',
    ],
  },
  {
    n: 4,
    topic: 'Classification and the metrics that matter',
    blurb: 'Logistic regression, thresholds, and why accuracy is usually the wrong number.',
    skills: ['Logistic Regression', 'Classification Metrics', 'Class Imbalance'],
    slides: [
      { heading: 'Logistic regression', bullets: ['Linear score pushed through a sigmoid', 'Outputs a calibrated-ish probability, not a class', 'The threshold is a separate decision'] },
      { heading: 'The confusion matrix', bullets: ['Four numbers, and every metric is a ratio of them', 'Precision: of what I flagged, how much was real', 'Recall: of what was real, how much did I catch'] },
      { heading: 'Accuracy is a trap', bullets: ['99% accuracy on a 1% positive rate means nothing', 'Always report the base rate alongside', 'Pick the metric from the cost of each error'] },
      { heading: 'ROC and PR curves', bullets: ['ROC is threshold-independent', 'PR is more honest under heavy imbalance', 'AUC summarises; it does not choose for you'] },
      { heading: 'Choosing a threshold', bullets: ['Driven by the cost of a false positive vs a false negative', 'This is a business decision, not a modelling one', 'Document it and revisit it'] },
    ],
    transcript: [
      'Classification. And more importantly, how to tell whether your classifier is any good, because the default answer people reach for is wrong most of the time.',
      'Logistic regression takes a linear score and pushes it through a sigmoid. What comes out is a number between zero and one that behaves roughly like a probability. It is not a class yet. Turning it into a class requires a threshold, and that is a separate decision.',
      'The confusion matrix is four numbers and every metric you have heard of is some ratio of them. Precision asks: of the things I flagged, how many were real. Recall asks: of the things that were real, how many did I catch.',
      'Now, accuracy. If one percent of your cases are positive, a model that says no to everything gets ninety-nine percent accuracy. Always tell me the base rate.',
      'ROC curves are threshold independent, which is nice. But under heavy imbalance, precision-recall curves are more honest, because ROC flatters you with all those easy negatives.',
      'Picking the threshold is a business decision. What does a false positive cost you versus a false negative? Write that down in your project.',
    ],
  },
  {
    n: 5,
    topic: 'Trees and ensembles',
    blurb: 'Decision trees, bagging, random forests, and gradient boosting.',
    skills: ['Decision Trees', 'Random Forests', 'Gradient Boosting'],
    slides: [
      { heading: 'A single tree', bullets: ['Greedy recursive splitting on one feature at a time', 'Readable, and captures interactions for free', 'Unstable: small data changes give different trees'] },
      { heading: 'Bagging', bullets: ['Fit many trees on bootstrap samples', 'Average their predictions', 'Variance falls, bias stays roughly put'] },
      { heading: 'Random forests', bullets: ['Bagging plus a random subset of features per split', 'Decorrelates the trees, which is the real win', 'Strong default on tabular data'] },
      { heading: 'Gradient boosting', bullets: ['Fit each tree to the residuals of the ones before', 'Sequential, so it overfits if you let it', 'Learning rate and tree count trade against each other'] },
      { heading: 'Which one', bullets: ['Tabular data: start with a boosted tree', 'Need an explanation: start with one shallow tree', 'Neural nets are rarely the answer here'] },
    ],
    transcript: [
      'Trees. This is the family that actually wins on the kind of data most of you will work with, which is tables.',
      'A single decision tree splits greedily, one feature at a time, and you can read the result out loud. It also captures interactions without you writing them down. The downside is instability. Change a few rows and you get a visibly different tree.',
      'Bagging fixes that. Fit many trees on bootstrap resamples and average them. Variance drops, bias stays about where it was.',
      'Random forests add one idea on top: at each split, only consider a random subset of the features. That decorrelates the trees, and decorrelation is where most of the gain actually comes from.',
      'Boosting is a different idea. Each tree is fit to the errors of the ones before it. It is sequential and it will happily overfit, so the learning rate and the number of trees trade off against each other.',
      'Practical advice. On tabular data, start with a boosted tree. If someone needs to read the model, start with one shallow tree. Do not reach for a neural network here.',
    ],
  },
  {
    n: 6,
    topic: 'Model selection and cross-validation',
    blurb: 'K-fold, nested CV, and how hyperparameter search quietly overfits.',
    skills: ['Cross-Validation', 'Hyperparameter Search', 'Overfitting Diagnosis'],
    slides: [
      { heading: 'K-fold', bullets: ['Every row is validation exactly once', 'Five or ten folds is almost always enough', 'Stratify when classes are imbalanced'] },
      { heading: 'Search strategies', bullets: ['Grid search is exhaustive and wasteful', 'Random search beats grid at equal budget', 'Bayesian search helps only on expensive fits'] },
      { heading: 'Selection overfitting', bullets: ['Try enough configurations and one wins by luck', 'Your CV score is now optimistic', 'Nested CV measures the honest number'] },
      { heading: 'Learning curves', bullets: ['Plot error against training set size', 'Gap that stays open: variance, get more data', 'Both curves high and flat: bias, get a better model'] },
      { heading: 'Stopping', bullets: ['Decide the metric before you start', 'Decide the budget before you start', 'Then actually stop'] },
    ],
    transcript: [
      'Cross validation, and the subtler problem hiding inside it, which is that model selection is itself a form of fitting.',
      'K-fold is simple. Split into k parts, train on k minus one, validate on the held out one, rotate. Every row serves as validation exactly once. Five or ten folds is fine. Stratify if your classes are imbalanced.',
      'For search, random beats grid at the same budget, and that result surprises people every year. The reason is that most hyperparameters do not matter much, and grid search spends its budget varying the ones that do not.',
      'Here is the trap. If you try two hundred configurations, one of them will look good by luck. Your cross validation score is now optimistic. Nested cross validation is how you get the honest number.',
      'Learning curves tell you what to do next. If the gap between training and validation stays open as data grows, that is variance, go get more data. If both curves are high and flat, that is bias, go get a better model.',
      'And decide your metric and your budget before you start, then actually stop when you hit it.',
    ],
  },
  {
    n: 7,
    topic: 'Feature engineering in practice',
    blurb: 'Encoding, scaling, interactions, and building the pipeline as one object.',
    skills: ['Feature Construction', 'Categorical Encoding', 'Pipelines'],
    slides: [
      { heading: 'Categoricals', bullets: ['One-hot for low cardinality', 'Target encoding for high cardinality, fit inside the fold', 'Never assign arbitrary integers to unordered categories'] },
      { heading: 'Scaling', bullets: ['Required for distance and gradient methods', 'Irrelevant for trees', 'Fit the scaler on training data only'] },
      { heading: 'Interactions', bullets: ['Linear models need them written down', 'Trees discover them', 'Domain knowledge beats brute force'] },
      { heading: 'The pipeline object', bullets: ['Preprocessing and model as one fitted artifact', 'Makes leakage in cross-validation structurally impossible', 'Serialise the pipeline, not the model'] },
      { heading: 'Text and dates', bullets: ['Dates are a rich source of cheap features', 'Text: start with counts before embeddings', 'Cyclical encodings for hour and month'] },
    ],
    transcript: [
      'Feature engineering. This is the part that is unglamorous and decides who wins the project.',
      'Categoricals first. One-hot encoding is fine when cardinality is low. When it is high, target encoding works, but you must fit it inside each fold or you have leaked the label.',
      'And please never assign arbitrary integers to unordered categories. The model will read that as an ordering and you have told it something false.',
      'Scaling matters for anything distance based or gradient based. It is completely irrelevant for trees. Fit the scaler on training data only, which brings us to the pipeline.',
      'Wrap your preprocessing and your model into a single pipeline object. Then cross validation refits the preprocessing inside each fold automatically and leakage becomes structurally impossible rather than something you remember to avoid.',
      'Dates are underrated. Day of week, hour of day, days since last event. Cheap features, often strong. And use cyclical encodings so that hour twenty-three sits next to hour zero.',
    ],
  },
  {
    n: 8,
    topic: 'Midterm review and exam',
    blurb: 'Consolidation of weeks 1-7, then the in-class midterm.',
    skills: ['Bias-Variance Tradeoff', 'Data Leakage', 'Classification Metrics'],
    slides: [
      { heading: 'What the exam covers', bullets: ['Weeks 1 through 7', 'Conceptual reasoning, not code recall', 'One question will ask you to find the leakage'] },
      { heading: 'Things people get wrong', bullets: ['Confusing validation and test', 'Reporting accuracy under imbalance', 'Scaling before splitting'] },
      { heading: 'Worked example', bullets: ['A churn dataset with a suspiciously good feature', 'Trace where the information came from', 'Fix the split and watch the score fall'] },
    ],
    transcript: [
      'Review session. The exam covers weeks one through seven, and it is conceptual. I am not going to ask you to recall an API signature.',
      'The three things people get wrong every year: confusing validation with test, reporting bare accuracy on an imbalanced problem, and scaling before splitting.',
      'Let me walk through a churn dataset where one feature is suspiciously predictive. We trace where that information came from, find that it was populated after the customer cancelled, fix the split, and watch the score drop to something believable.',
    ],
  },
  {
    n: 9,
    topic: 'Neural networks from scratch',
    blurb: 'Perceptrons, hidden layers, backpropagation, and what depth buys you.',
    skills: ['Neural Networks', 'Backpropagation', 'Activation Functions'],
    slides: [
      { heading: 'From linear to non-linear', bullets: ['A stack of linear layers is still linear', 'The activation is what buys you expressiveness', 'ReLU is the default for good practical reasons'] },
      { heading: 'Forward pass', bullets: ['Matrix multiply, add bias, apply activation', 'Repeat per layer', 'The last layer matches the task, not the data'] },
      { heading: 'Backpropagation', bullets: ['The chain rule applied systematically', 'Cache activations on the way forward', 'Gradients flow back layer by layer'] },
      { heading: 'What depth buys', bullets: ['Composition of features, not raw capacity', 'Deeper needs less width for the same function', 'Harder to optimise as it grows'] },
      { heading: 'When not to', bullets: ['Small tabular data: use a boosted tree', 'No GPU and no time: use a boosted tree', 'Need an explanation: use something simpler'] },
    ],
    transcript: [
      'Neural networks. We are going to build one on the board before we touch a framework, because the framework hides exactly the part you need to understand.',
      'Start here: a stack of linear layers with nothing between them is still a linear function. The activation is the entire source of expressiveness. ReLU is the default, and the reason is boring and practical, which is that its gradient does not vanish.',
      'The forward pass is a matrix multiply, add a bias, apply the activation, repeat. The only layer that is special is the last one, which has to match the task.',
      'Backpropagation is the chain rule applied systematically. You cache activations on the way forward, and gradients flow back layer by layer.',
      'What does depth buy you? Composition. A deep network can represent a function that a shallow one needs exponentially more width for. The cost is that it gets harder to optimise.',
      'And I will say it again, because someone will ignore it in their project: on small tabular data, use a boosted tree.',
    ],
  },
  {
    n: 10,
    topic: 'Training deep models',
    blurb: 'Optimisers, learning-rate schedules, dropout, batch norm, early stopping.',
    skills: ['Optimization', 'Regularization', 'Neural Networks'],
    slides: [
      { heading: 'Optimisers', bullets: ['SGD with momentum is still competitive', 'Adam converges fast and generalises slightly worse', 'The learning rate matters more than the optimiser'] },
      { heading: 'Schedules', bullets: ['Warmup then decay is the reliable default', 'Cosine decay works well and has one knob', 'Plateau-based schedules react rather than plan'] },
      { heading: 'Regularising a network', bullets: ['Dropout: random deactivation during training only', 'Weight decay: the same idea as ridge', 'Early stopping: the cheapest regulariser there is'] },
      { heading: 'Normalisation', bullets: ['Batch norm stabilises the scale of activations', 'Layer norm when batches are small or variable', 'Both mostly help optimisation, not capacity'] },
      { heading: 'Diagnosing a bad run', bullets: ['Loss is NaN: learning rate too high', 'Loss flat: too low, or the data is wrong', 'Train falls, validation rises: overfitting, stop earlier'] },
    ],
    transcript: [
      'Training. Everything today is about making optimisation behave, because an architecture you cannot train is worth nothing.',
      'On optimisers: stochastic gradient descent with momentum is still competitive with anything. Adam converges faster and tends to generalise very slightly worse. Honestly the learning rate matters more than which optimiser you picked.',
      'Schedules. Warm up, then decay. Cosine decay is a good default because it has one knob. Plateau based schedules are reactive, which is fine but slower.',
      'Regularisation for networks. Dropout randomly deactivates units during training only, and people forget that only. Weight decay is ridge under a different name. Early stopping is free and everyone should use it.',
      'Normalisation layers mostly help optimisation rather than capacity. Batch norm when your batches are big and stable, layer norm when they are not.',
      'Diagnosing. Loss goes to NaN, your learning rate is too high. Loss is flat, it is too low or your data pipeline is broken. Training loss falls while validation rises, you are overfitting, stop earlier.',
    ],
  },
  {
    n: 11,
    topic: 'Representation learning and embeddings',
    blurb: 'Learned dense representations, similarity, and transfer.',
    skills: ['Embeddings', 'Transfer Learning', 'Similarity Search'],
    slides: [
      { heading: 'Why embeddings', bullets: ['One-hot vectors carry no notion of similarity', 'A dense vector puts related things near each other', 'Nearness is learned from the task, not declared'] },
      { heading: 'Geometry', bullets: ['Cosine similarity for direction, Euclidean for magnitude', 'Normalise before you compare', 'Dimensions are not individually interpretable'] },
      { heading: 'Transfer learning', bullets: ['Reuse a representation learned on a larger corpus', 'Freeze early layers, fine-tune late ones', 'This is the default when data is scarce'] },
      { heading: 'Similarity search', bullets: ['Exact search is fine below a million vectors', 'Approximate indexes trade recall for latency', 'Always measure recall against exact search'] },
      { heading: 'Failure modes', bullets: ['Embeddings inherit the biases of their training data', 'Distribution shift breaks nearness silently', 'A nearest neighbour is not an explanation'] },
    ],
    transcript: [
      'Embeddings. This is the idea that makes most of modern machine learning work, and it is simpler than the hype suggests.',
      'A one-hot vector says nothing about similarity. Every pair is equally far apart. A dense embedding puts related things near each other, and crucially that nearness is learned from a task rather than declared by you.',
      'On geometry: cosine similarity cares about direction, Euclidean distance cares about magnitude too. Normalise before you compare or you will get confusing results. And do not try to interpret individual dimensions.',
      'Transfer learning is how you use this when you have little data. Take a representation learned on a much larger corpus, freeze the early layers, fine tune the late ones.',
      'For search: below about a million vectors, exact search is fine, just do it. Above that you want an approximate index, and you must measure its recall against exact search rather than assuming.',
      'Failure modes matter here. Embeddings inherit the biases of whatever they were trained on, and distribution shift degrades nearness silently, with no error message.',
    ],
  },
  {
    n: 12,
    topic: 'Working with text',
    blurb: 'From bag-of-words to transformers, and what to reach for when.',
    skills: ['Text Representation', 'Embeddings', 'Transfer Learning'],
    slides: [
      { heading: 'Counts first', bullets: ['Bag of words and TF-IDF are strong baselines', 'Fast, interpretable, and hard to beat on small data', 'Start here and earn your way to something bigger'] },
      { heading: 'Tokenisation', bullets: ['Subword tokenisation handles unseen words', 'Token count, not word count, drives cost', 'The tokeniser is part of the model'] },
      { heading: 'Transformers', bullets: ['Attention lets every token see every other', 'Pretraining then fine-tuning is the standard recipe', 'Context length is a hard budget'] },
      { heading: 'Practical choices', bullets: ['Classification with few labels: fine-tune a small model', 'Search and retrieval: sentence embeddings', 'Generation: a hosted model, with evaluation'] },
      { heading: 'Evaluating text systems', bullets: ['Automatic metrics correlate weakly with usefulness', 'Build a small labelled eval set early', 'Read the failures yourself'] },
    ],
    transcript: [
      'Text. And I want to push back gently on the instinct to reach for the largest model available.',
      'Counts first. Bag of words with TF-IDF weighting is a genuinely strong baseline, it is fast, it is interpretable, and on a few thousand labelled documents it is hard to beat. Start there and earn your way up.',
      'Tokenisation. Modern systems use subword tokenisation, which means unseen words decompose into pieces rather than vanishing. And your cost is driven by token count, not word count. The tokeniser is part of the model, ship them together.',
      'Transformers use attention so that every token can see every other token. The recipe is pretrain on a large corpus, fine tune on your task. Context length is a hard budget, not a suggestion.',
      'Practically: few labels and a classification task, fine tune something small. Search, use sentence embeddings. Generation, use a hosted model but build an evaluation.',
      'Which brings me to evaluation. Automatic metrics for text correlate weakly with whether the thing is useful. Build a small labelled eval set early and read the failures yourself.',
    ],
  },
  {
    n: 13,
    topic: 'Evaluation beyond accuracy',
    blurb: 'Calibration, slice analysis, and error analysis that changes what you build.',
    skills: ['Model Evaluation', 'Calibration', 'Error Analysis'],
    slides: [
      { heading: 'Calibration', bullets: ['A 0.7 prediction should be right about 70% of the time', 'Reliability diagrams show where it is not', 'Platt scaling and isotonic regression fix it after the fact'] },
      { heading: 'Slice analysis', bullets: ['Aggregate metrics hide subgroup failures', 'Define slices before you look', 'A model that is fine overall can be useless for a segment'] },
      { heading: 'Error analysis', bullets: ['Sample a hundred errors and label the causes', 'Group causes, count them, fix the biggest group', 'This beats another round of hyperparameter search'] },
      { heading: 'Baselines you must beat', bullets: ['Majority class', 'Last observed value, for anything temporal', 'The existing human process'] },
      { heading: 'Reporting', bullets: ['Give an interval, not a point', 'State the base rate and the sample size', 'Say what the model should not be used for'] },
    ],
    transcript: [
      'Evaluation, properly this time. Accuracy was week four. This is the version that survives contact with a stakeholder.',
      'Calibration first. If your model says point seven, it should be right about seventy percent of the time. Many models are not calibrated, boosted trees especially. A reliability diagram shows you exactly where it goes wrong, and Platt scaling or isotonic regression will fix it after the fact.',
      'Slice analysis. Your aggregate metric hides subgroup failures. Define your slices before you look at the numbers, otherwise you will find whatever story you want.',
      'Error analysis is the highest value hour you will spend. Sample a hundred errors, label why each happened, group the causes, count them, and fix the biggest group. That beats another round of hyperparameter search essentially every time.',
      'Baselines you must beat: majority class, last observed value for anything temporal, and the existing human process. That last one gets skipped and it is the one that matters.',
      'When you report, give an interval rather than a point, state the base rate and the sample size, and say explicitly what the model should not be used for.',
    ],
  },
  {
    n: 14,
    topic: 'Fairness, robustness, and deployment risk',
    blurb: 'Distribution shift, monitoring, and the fairness definitions that conflict.',
    skills: ['Fairness', 'Distribution Shift', 'Model Monitoring'],
    slides: [
      { heading: 'Distribution shift', bullets: ['Covariate shift: inputs move, relationship holds', 'Concept drift: the relationship itself changes', 'Both show up as quiet degradation, not errors'] },
      { heading: 'Monitoring', bullets: ['Monitor inputs, not just outputs', 'Alert on the input distribution moving', 'Labels arrive late; do not wait for them'] },
      { heading: 'Fairness definitions', bullets: ['Demographic parity, equal opportunity, calibration', 'They are mathematically incompatible in general', 'You must choose, and justify the choice'] },
      { heading: 'Where bias enters', bullets: ['The sampling frame', 'The label definition', 'The deployment context'] },
      { heading: 'Before you ship', bullets: ['Who is harmed if this is wrong', 'How would you find out', 'How do you roll it back'] },
    ],
    transcript: [
      'Last content lecture. This is the one where we talk about what happens after the model leaves your laptop.',
      'Distribution shift. Covariate shift means your inputs have moved but the relationship still holds. Concept drift means the relationship itself has changed. Both look the same from the outside, which is quiet degradation with no error message.',
      'So monitor inputs, not just outputs. Your labels arrive weeks late, sometimes never. If you wait for them to tell you something broke, you have been broken for weeks.',
      'Fairness. There are several reasonable definitions, demographic parity, equal opportunity, calibration within groups, and there is a theorem that says you generally cannot satisfy them all at once. So you have to choose one and justify it. There is no technical escape from that choice.',
      'Bias enters in three places: who ended up in your sample, how you defined the label, and the context you deploy into. Not one of those is a modelling problem.',
      'Three questions before you ship anything. Who is harmed if this is wrong. How would you find out. How do you roll it back.',
    ],
  },
  {
    n: 15,
    topic: 'Project presentations',
    blurb: 'Teams present their systems; peer review and course wrap-up.',
    skills: ['Communication', 'Model Evaluation'],
    slides: [
      { heading: 'Format', bullets: ['Twelve minutes, three for questions', 'Everyone on the team speaks', 'Lead with the decision, not the architecture'] },
      { heading: 'What we are grading', bullets: ['Is the evaluation honest', 'Did you beat a real baseline', 'Do you know where it fails'] },
      { heading: 'Peer review', bullets: ['Two questions per team, submitted in advance', 'Score on clarity and evidence', 'Anonymous to the presenting team'] },
    ],
    transcript: [
      'Presentation day. Twelve minutes each with three for questions, and every member of the team speaks.',
      'Lead with the decision your system supports. Not the architecture. I have watched a lot of these and the ones that land start with what changes if this works.',
      'We are grading three things: is the evaluation honest, did you beat a real baseline, and do you know where the thing fails.',
      'Peer review as usual, two questions per team submitted in advance, scored on clarity and evidence, and anonymous to the team presenting.',
    ],
  },
]

/** Flat, de-duplicated skill list for the course, in teaching order. */
export const ALL_SKILLS: string[] = (() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of WEEKS) for (const s of w.skills) if (!seen.has(s)) { seen.add(s); out.push(s) }
  return out
})()

/** Three top-level groupings, so the skill tree and roadmap are not flat. */
export const SKILL_GROUPS: Array<{ name: string; children: string[] }> = [
  {
    name: 'Foundations',
    children: ['Problem Framing', 'Supervised vs Unsupervised', 'Train/Test Splitting', 'Data Leakage', 'Feature Construction', 'Categorical Encoding', 'Pipelines'],
  },
  {
    name: 'Models',
    children: ['Linear Regression', 'Regularization', 'Logistic Regression', 'Decision Trees', 'Random Forests', 'Gradient Boosting', 'Neural Networks', 'Backpropagation', 'Activation Functions', 'Optimization', 'Embeddings', 'Transfer Learning', 'Text Representation', 'Similarity Search'],
  },
  {
    name: 'Evaluation and Risk',
    children: ['Bias-Variance Tradeoff', 'Classification Metrics', 'Class Imbalance', 'Cross-Validation', 'Hyperparameter Search', 'Overfitting Diagnosis', 'Model Evaluation', 'Calibration', 'Error Analysis', 'Fairness', 'Distribution Shift', 'Model Monitoring', 'Communication'],
  },
]

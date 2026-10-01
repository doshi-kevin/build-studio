// Generates real, multi-page PDFs for the dev seed — not fabricated page-count
// metadata on a reused 1-page file. jsPDF is already a project dependency
// (package.json), works standalone in this Node/tsx setup, and needs no DOM.
//
// Each generator returns both the PDF bytes and the TRUE page count, so callers
// can set extraction metadata that matches the actual file instead of a made-up
// number (the confusion this fixes: a module claiming "47 pages" that opens to 1).

import { jsPDF } from 'jspdf'

const MARGIN = 20
const PAGE_WIDTH = 210
const PAGE_HEIGHT = 297
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2
const BOTTOM = PAGE_HEIGHT - MARGIN

class Flow {
  doc = new jsPDF()
  y = MARGIN

  private breakIfNeeded(lineHeight: number) {
    if (this.y + lineHeight > BOTTOM) {
      this.doc.addPage()
      this.y = MARGIN
    }
  }

  heading(text: string) {
    this.breakIfNeeded(12)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(15)
    this.doc.text(text, MARGIN, this.y)
    this.y += 10
  }

  subheading(text: string) {
    this.breakIfNeeded(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(12)
    this.doc.text(text, MARGIN, this.y)
    this.y += 7
  }

  paragraph(text: string) {
    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(11)
    const lines: string[] = this.doc.splitTextToSize(text, USABLE_WIDTH)
    for (const line of lines) {
      this.breakIfNeeded(6)
      this.doc.text(line, MARGIN, this.y)
      this.y += 6
    }
    this.y += 3
  }

  bullets(items: string[]) {
    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(11)
    for (const item of items) {
      const lines: string[] = this.doc.splitTextToSize(item, USABLE_WIDTH - 6)
      lines.forEach((line, i) => {
        this.breakIfNeeded(6)
        this.doc.text(i === 0 ? `•  ${line}` : `   ${line}`, MARGIN, this.y)
        this.y += 6
      })
    }
    this.y += 3
  }

  spacer(mm = 4) {
    this.y += mm
  }

  finish(): { bytes: Uint8Array; pageCount: number } {
    const pageCount = this.doc.internal.pages.length - 1
    const bytes = new Uint8Array(this.doc.output('arraybuffer'))
    return { bytes, pageCount }
  }
}

export function generateSyllabus(): { bytes: Uint8Array; pageCount: number } {
  const f = new Flow()

  f.heading('CS101 — Introduction to Programming')
  f.subheading('Course Syllabus, Spring 2026')
  f.paragraph(
    'Instructor: Paula Professor  ·  Email: professor@scholera.dev  ·  Office Hours: Tue/Thu 2:00-3:30pm',
  )
  f.spacer()

  f.subheading('Course Description')
  f.paragraph(
    'This course introduces the fundamentals of programming and computational thinking. Students will learn ' +
      'core data structures, algorithm design, and complexity analysis through weekly lectures, hands-on labs, ' +
      'and a series of programming assignments. No prior programming experience is assumed, but comfort with ' +
      'basic algebra and logical reasoning will help.',
  )

  f.subheading('Learning Objectives')
  f.bullets([
    'Write, test, and debug programs in Python using standard control flow and data structures.',
    'Analyze the time and space complexity of an algorithm using Big-O notation.',
    'Choose an appropriate data structure (array, linked list, stack, queue, hash table) for a given problem.',
    'Explain the tradeoffs between different search and sort strategies.',
    'Collaborate effectively on a small team programming project.',
  ])

  f.subheading('Grading Breakdown')
  f.bullets([
    'Homework assignments: 30% — released roughly biweekly, submitted electronically.',
    'Quizzes: 20% — short, auto-graded, covering the two most recent weeks of material.',
    'Team project: 25% — a semester-long project built in teams of 3-4 students.',
    'Final exam: 25% — cumulative, covering all course material.',
  ])

  f.subheading('Course Policies')
  f.paragraph(
    'Attendance: Class attendance is not directly graded, but material covered in lecture regularly appears on ' +
      'quizzes and the final exam. Recordings are not guaranteed to be available, so plan to attend live sessions.',
  )
  f.paragraph(
    'Late work: Assignments submitted after the deadline lose 10% of the available points per day late, up to a ' +
      'maximum of 3 days. After that, the assignment can no longer be submitted for credit except by prior ' +
      'arrangement with the instructor.',
  )
  f.paragraph(
    'Academic integrity: You may discuss problem-solving strategies with classmates, but all submitted code must ' +
      'be your own. Submitting code you did not write, whether from a classmate, an online source, or an AI ' +
      'assistant, without disclosure is a violation of the university academic integrity policy.',
  )
  f.paragraph(
    'Accommodations: Students with a documented disability who may need accommodations in this course should ' +
      'contact the instructor as early in the semester as possible.',
  )

  f.subheading('Weekly Schedule')
  f.bullets([
    'Week 1 — Course logistics, toolchain setup, and your first program. Lab: install Python and a code editor.',
    'Week 2 — Data processing lifecycle: cleaning, encoding, and splitting a dataset. Lab: clean a messy CSV.',
    'Week 3 — K-nearest neighbour and distance metrics. Lab: implement KNN from scratch on a small dataset.',
    'Week 4 — Algorithm basics and complexity analysis. Lab: measure real running times against Big-O predictions.',
    'Week 5 — Applied predictive modelling case study. Lab: build and evaluate a simple classifier.',
    'Week 6 — Model evaluation: cross-validation, confusion matrices, and precision/recall. No formal lab.',
    'Week 7 — Clustering methods: k-means and hierarchical clustering. Lab: cluster an unlabeled dataset.',
    'Week 9 — Final review and practice problems. Optional review session before the final exam.',
  ])

  f.subheading('Grading Scale')
  f.bullets([
    'A: 93-100  ·  A-: 90-92  ·  B+: 87-89  ·  B: 83-86  ·  B-: 80-82',
    'C+: 77-79  ·  C: 73-76  ·  C-: 70-72  ·  D: 60-69  ·  F: below 60',
    'Grades are not curved. The scale above is fixed for the entire semester.',
  ])

  f.subheading('Required Materials')
  f.paragraph(
    'No paid textbook is required. All readings, lecture decks, and reference material are posted under ' +
      'Modules for each week. You will need a laptop capable of running Python 3.12 and a code editor of your ' +
      'choice; VS Code is recommended and covered in the Week 1 setup lab.',
  )

  f.subheading('Communication')
  f.paragraph(
    'Announcements and deadline reminders are posted through the course platform, not email — check the ' +
      'Announcements tab regularly. For questions about course content, post in the course discussion board so ' +
      'classmates can benefit from the answer too. For personal or grading matters, email the instructor directly ' +
      'and allow up to 48 hours for a response outside of exam weeks.',
  )

  f.subheading('Use of AI Tools')
  f.paragraph(
    'You may use AI coding assistants to help you understand concepts or debug your own code, but you must be ' +
      'able to explain every line you submit. Assignments that ask you to implement an algorithm "from scratch" ' +
      'require your own implementation logic; generating the whole solution from a prompt and submitting it as-is ' +
      'is treated the same as copying a classmate\'s work.',
  )

  f.subheading('Regrade Requests')
  f.paragraph(
    'If you believe an assignment or quiz was graded incorrectly, submit a regrade request within one week of ' +
      'receiving your grade, with a specific explanation of what you believe was missed or miscounted. Requests ' +
      'submitted after the one-week window will not be considered except in documented emergencies. Note that a ' +
      'regrade request re-opens the ENTIRE submission for review, not just the section in question, so a score ' +
      'can go down as well as up.',
  )

  f.subheading('Classroom Conduct')
  f.paragraph(
    'This course covers material at very different paces for different students, and questions that feel basic ' +
      'to one student are often exactly what another student needed to hear. Treat every question in lecture, ' +
      'lab, and the discussion board with the same respect you would want for your own. Disruptive behavior, ' +
      'including mocking a classmate\'s question or dismissing a teammate\'s contribution on the team project, ' +
      'will be addressed directly and can affect your participation standing in the course.',
  )

  return f.finish()
}

export function generateLectureNotes(): { bytes: Uint8Array; pageCount: number } {
  const f = new Flow()

  f.heading('Data Structures & Algorithmic Complexity')
  f.subheading('Lecture Notes — Week 4')
  f.spacer()

  f.subheading('1. Why Complexity Matters')
  f.paragraph(
    'Two programs can solve the same problem and produce the same output, yet behave completely differently as ' +
      'the input grows. A program that takes one second on 100 items might take an hour on 100,000 items, or it ' +
      'might barely notice the difference. Big-O notation gives us a way to describe how the running time (or ' +
      'memory use) of an algorithm grows as the size of its input grows, independent of the specific hardware ' +
      'or programming language used to run it.',
  )
  f.paragraph(
    'When we say an algorithm runs in O(n) time, we mean that in the worst case, the number of basic operations ' +
      'it performs grows linearly with the input size n. An algorithm that runs in O(n^2) time grows much faster: ' +
      'doubling the input roughly quadruples the work. The difference between these two categories is often the ' +
      'difference between a program that scales to millions of users and one that does not.',
  )

  f.subheading('2. Common Complexity Classes')
  f.bullets([
    'O(1) — constant time. Looking up a value by its array index does not get slower as the array grows.',
    'O(log n) — logarithmic time. Binary search cuts the remaining search space in half on every step.',
    'O(n) — linear time. Scanning every element once, such as finding the maximum value in an unsorted list.',
    'O(n log n) — the complexity of the best general-purpose sorting algorithms, such as merge sort.',
    'O(n^2) — quadratic time. Comparing every pair of elements, such as a naive duplicate-detection routine.',
  ])

  f.subheading('3. Arrays vs. Linked Lists')
  f.paragraph(
    'An array stores its elements in one contiguous block of memory, so accessing the element at a given index ' +
      'is O(1): the address can be computed directly from the index. The tradeoff shows up when inserting or ' +
      'removing an element in the middle of the array, since every element after it must shift over, which is ' +
      'an O(n) operation in the worst case.',
  )
  f.paragraph(
    'A linked list stores each element in its own node, with a pointer to the next node. Inserting or removing a ' +
      'node once you already have a reference to its neighbour is O(1), since no shifting is required. The ' +
      'tradeoff is that finding the k-th element requires walking the list from the head, which is O(n) — there ' +
      'is no way to jump directly to an arbitrary position the way an array index allows.',
  )

  f.subheading('4. Stacks and Queues')
  f.paragraph(
    'A stack is Last-In-First-Out (LIFO): the most recently added item is the first one removed, like a stack of ' +
      'plates. The undo button in a text editor is a classic stack: each edit pushes onto the stack, and undo ' +
      'pops the most recent one off.',
  )
  f.paragraph(
    'A queue is First-In-First-Out (FIFO): items are removed in the same order they were added, like a line at a ' +
      'coffee shop. A print spooler is a queue: documents print in the order they were sent, not in reverse.',
  )

  f.subheading('5. Hash Tables')
  f.paragraph(
    'A hash table maps keys to values using a hash function that converts a key into an array index. In the ' +
      'average case, lookup, insertion, and deletion are all O(1), which is why hash tables are the default ' +
      'choice for problems like counting word frequency or checking whether a value has been seen before.',
  )
  f.paragraph(
    'The worst case is O(n), and it happens when many keys hash to the same index (a "collision") and the table ' +
      'degrades into something closer to a linked list. A well-designed hash function and a table that resizes ' +
      'as it fills up make this worst case rare in practice, but it is worth knowing it exists — a claim of ' +
      '"O(1) lookup" for a hash table is really "O(1) on average, assuming reasonable hash distribution."',
  )

  f.subheading('Worked Example')
  f.paragraph(
    'Suppose you need to find the first repeated character in a string of length n. A naive approach compares ' +
      'every pair of characters, which is O(n^2). Using a hash set instead: walk the string once, and for each ' +
      'character check whether it is already in the set. If it is, you have found your answer; if not, add it ' +
      'and continue. Each check and insertion is O(1) on average, so the whole algorithm is O(n) — a direct ' +
      'illustration of trading a small amount of memory (the hash set) for a large improvement in running time.',
  )

  f.subheading('6. Trees')
  f.paragraph(
    'A tree generalizes a linked list by letting each node point to more than one child, which is what makes it ' +
      'useful for representing hierarchical data: a file system, an HTML document, or the roadmap structure a ' +
      'course is organized into. A binary tree restricts each node to at most two children, commonly called left ' +
      'and right.',
  )
  f.paragraph(
    'A binary search tree adds one rule: every value in a node\'s left subtree is smaller than the node, and ' +
      'every value in its right subtree is larger. That rule is what makes search, insertion, and deletion all ' +
      'O(log n) on a balanced tree — each comparison eliminates roughly half of the remaining nodes, the same ' +
      'idea as binary search on a sorted array, but without needing to shift elements when the tree changes. If ' +
      'the tree becomes unbalanced (for example, by inserting already-sorted data one item at a time), it ' +
      'degrades toward a linked list and those operations slow to O(n).',
  )

  f.subheading('Choosing a Data Structure')
  f.paragraph(
    'When you are deciding which structure to reach for, the question that matters most is which operation your ' +
      'program does most often. If you mostly look things up by position, an array wins. If you mostly insert ' +
      'and remove from the ends, a linked list, stack, or queue wins. If you mostly check "have I seen this ' +
      'before" or count occurrences, a hash table wins. If you need the data to stay sorted while it grows, a ' +
      'balanced binary search tree wins. There is rarely one "best" data structure in the abstract — there is ' +
      'only the one that matches the operations your specific program performs most often.',
  )

  f.subheading('Key Takeaways')
  f.bullets([
    'Big-O describes growth rate, not exact running time — it tells you how an algorithm scales, not how fast it is on one input.',
    'Arrays give fast lookup by index; linked lists give fast insertion/removal once you have a reference.',
    'Stacks are LIFO, queues are FIFO — the right choice depends on the order you need items back in.',
    'Hash tables trade memory for average-case O(1) lookup, insertion, and deletion.',
  ])

  return f.finish()
}

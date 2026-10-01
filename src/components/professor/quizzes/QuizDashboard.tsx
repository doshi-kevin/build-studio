'use client'

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/professor/PageHeader'
import { QuizList } from './QuizList'
import { QuestionBankManager } from './QuestionBankManager'

interface QuizDashboardProps {
  sectionId: string
}

export function QuizDashboard({ sectionId }: QuizDashboardProps) {
  const [activeTab, setActiveTab] = useState('quizzes')

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quizzes"
        description="Create quizzes from your question bank and assign them to students."
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="quizzes">Quizzes</TabsTrigger>
          <TabsTrigger value="question-bank">Question Bank</TabsTrigger>
        </TabsList>

        <TabsContent value="quizzes" className="mt-6">
          <QuizList sectionId={sectionId} />
        </TabsContent>

        <TabsContent value="question-bank" className="mt-6">
          <QuestionBankManager sectionId={sectionId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

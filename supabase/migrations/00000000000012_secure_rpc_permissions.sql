-- Security fix: Restrict increment_student_quizzes_taken RPC to service_role only.
-- This function is SECURITY DEFINER (bypasses RLS). Without this restriction,
-- any authenticated user could call supabase.rpc() directly to manipulate
-- student Elo ratings for any student in any section.

REVOKE EXECUTE ON FUNCTION increment_student_quizzes_taken FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_student_quizzes_taken TO service_role;

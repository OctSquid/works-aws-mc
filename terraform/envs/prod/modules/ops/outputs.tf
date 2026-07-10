output "budget_name" {
  description = "作成した Budgets の名前"
  value       = aws_budgets_budget.monthly.name
}

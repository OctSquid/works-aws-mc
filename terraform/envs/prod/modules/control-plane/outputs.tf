output "function_url" {
  description = "mc-interactions の Lambda Function URL（Discord Interactions Endpoint）"
  value       = aws_lambda_function_url.interactions.function_url
}

output "lambda_function_names" {
  description = "Lambda 関数名の一覧"
  value       = [for f in aws_lambda_function.this : f.function_name]
}

output "lambda_function_arns" {
  description = "Lambda 関数 ARN のマップ（dist ディレクトリ名 -> ARN）"
  value       = { for k, f in aws_lambda_function.this : k => f.arn }
}

output "dynamodb_table_name" {
  description = "状態管理用 DynamoDB テーブル名"
  value       = aws_dynamodb_table.state.name
}

output "dynamodb_table_arn" {
  description = "状態管理用 DynamoDB テーブル ARN"
  value       = aws_dynamodb_table.state.arn
}

output "ssm_parameter_names" {
  description = "作成した SSM パラメータ名の一覧（値はプレースホルダ。実値は手動投入）"
  value       = [for p in aws_ssm_parameter.this : p.name]
}

# CI (terraform.yml) とローカルの両方で自動読込される値。
# シークレットはここに書かない (SSM Parameter Store に投入する)。
domain_name  = "worksmc.dpdns.org"
subdomain    = "" # 空 = apex (worksmc.dpdns.org) をそのままサーバー名にする
budget_email = "redacted@example.invalid"

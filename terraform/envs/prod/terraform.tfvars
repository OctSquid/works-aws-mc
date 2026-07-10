# CI (terraform.yml) とローカルの両方で自動読込される値。
# シークレットはここに書かない (SSM Parameter Store に投入する)。
domain_name  = "worksmc.dpdns.org"
subdomain    = "" # 空 = apex (worksmc.dpdns.org) をそのままサーバー名にする
budget_email = "redacted@example.invalid"

# ワールドスナップショットの保持世代数。毎回別ボリューム由来のため増分にならず
# フル容量課金になる。世代数 × ワールド実使用量 × $0.05/GB月 がコストの目安
snapshot_retention = 3

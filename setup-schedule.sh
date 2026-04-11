#!/bin/bash

# 数据采集调度设置脚本

PROJECT_DIR="/Users/yyzinotary/Documents/uk-supplier-intake"
LOG_DIR="$PROJECT_DIR/logs"

echo "=========================================="
echo "UK Supplier Intake - 调度设置"
echo "=========================================="
echo ""

# 创建日志目录
mkdir -p "$LOG_DIR"
echo "✓ 日志目录已创建: $LOG_DIR"
echo ""

# 显示方案选择
echo "请选择调度方案:"
echo ""
echo "1. 保守型（推荐）"
echo "   - SRA: 每天 2:00"
echo "   - Faculty Office: 每天 3:00"
echo "   - Law Society: 每周一 4:00"
echo ""
echo "2. 积极型"
echo "   - SRA: 每天 2:00"
echo "   - Faculty Office: 每天 3:00"
echo "   - Law Society: 每周一、四 4:00"
echo ""
echo "3. 按需型"
echo "   - SRA: 每天 2:00"
echo "   - Faculty Office: 每天 3:00"
echo "   - Law Society: 手动执行"
echo ""
echo "4. 仅显示 cron 配置（不安装）"
echo ""
read -p "请输入选项 (1-4): " choice

case $choice in
  1)
    CRON_CONTENT="# UK Supplier Intake - 保守型
0 2 * * * cd $PROJECT_DIR && SOURCE=sra npm run ingest >> $LOG_DIR/sra.log 2>&1
0 3 * * * cd $PROJECT_DIR && SOURCE=facultyoffice npm run ingest >> $LOG_DIR/faculty.log 2>&1
0 4 * * 1 cd $PROJECT_DIR && SOURCE=lawsociety npm run ingest >> $LOG_DIR/lawsociety.log 2>&1"
    ;;
  2)
    CRON_CONTENT="# UK Supplier Intake - 积极型
0 2 * * * cd $PROJECT_DIR && SOURCE=sra npm run ingest >> $LOG_DIR/sra.log 2>&1
0 3 * * * cd $PROJECT_DIR && SOURCE=facultyoffice npm run ingest >> $LOG_DIR/faculty.log 2>&1
0 4 * * 1,4 cd $PROJECT_DIR && SOURCE=lawsociety npm run ingest >> $LOG_DIR/lawsociety.log 2>&1"
    ;;
  3)
    CRON_CONTENT="# UK Supplier Intake - 按需型
0 2 * * * cd $PROJECT_DIR && SOURCE=sra npm run ingest >> $LOG_DIR/sra.log 2>&1
0 3 * * * cd $PROJECT_DIR && SOURCE=facultyoffice npm run ingest >> $LOG_DIR/faculty.log 2>&1"
    ;;
  4)
    echo ""
    echo "=========================================="
    echo "Cron 配置示例"
    echo "=========================================="
    echo ""
    echo "# 保守型"
    echo "0 2 * * * cd $PROJECT_DIR && SOURCE=sra npm run ingest >> $LOG_DIR/sra.log 2>&1"
    echo "0 3 * * * cd $PROJECT_DIR && SOURCE=facultyoffice npm run ingest >> $LOG_DIR/faculty.log 2>&1"
    echo "0 4 * * 1 cd $PROJECT_DIR && SOURCE=lawsociety npm run ingest >> $LOG_DIR/lawsociety.log 2>&1"
    echo ""
    echo "手动安装: crontab -e"
    exit 0
    ;;
  *)
    echo "无效选项"
    exit 1
    ;;
esac

echo ""
echo "=========================================="
echo "将要添加的 Cron 任务:"
echo "=========================================="
echo "$CRON_CONTENT"
echo ""
read -p "确认安装? (y/n): " confirm

if [ "$confirm" != "y" ]; then
  echo "已取消"
  exit 0
fi

# 备份现有 crontab
crontab -l > /tmp/crontab_backup_$(date +%Y%m%d_%H%M%S).txt 2>/dev/null
echo "✓ 已备份现有 crontab"

# 添加新任务
(crontab -l 2>/dev/null; echo ""; echo "$CRON_CONTENT") | crontab -
echo "✓ Cron 任务已安装"

echo ""
echo "=========================================="
echo "安装完成！"
echo "=========================================="
echo ""
echo "查看当前 cron 任务:"
echo "  crontab -l"
echo ""
echo "查看日志:"
echo "  tail -f $LOG_DIR/sra.log"
echo "  tail -f $LOG_DIR/faculty.log"
echo "  tail -f $LOG_DIR/lawsociety.log"
echo ""
echo "手动测试:"
echo "  SOURCE=sra npm run ingest"
echo "  SOURCE=facultyoffice npm run ingest"
echo "  SOURCE=lawsociety npm run ingest"
echo ""

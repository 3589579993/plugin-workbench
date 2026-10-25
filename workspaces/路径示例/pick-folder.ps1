# 演示「路径由脚本自己问用户」的写法（工作台不参与选路径）
# 工作台只负责：站在本工作区包目录里把这个脚本启动起来。
# 于是脚本能用相对路径找到同包的文件，也能自己弹窗问用户要路径——
# 这样这个工作区包换到任何人电脑上、或拿去命令行里跑，都一样能用。

$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, '选择一个文件夹，这里会列出它的内容', 0)

if (-not $folder) {
  Write-Host '（已取消：没有选择文件夹）'
  exit 0
}

$path = $folder.Self.Path
Write-Host ('选中的文件夹：' + $path)
Write-Host ''

$items = Get-ChildItem -LiteralPath $path -ErrorAction SilentlyContinue
if (-not $items) { Write-Host '（这个文件夹是空的，或者读不了）'; exit 0 }

$items | Select-Object -First 20 | ForEach-Object {
  if ($_.PSIsContainer) { Write-Host ('  [目录] ' + $_.Name) }
  else                  { Write-Host ('  [文件] ' + $_.Name) }
}

$total = ($items | Measure-Object).Count
if ($total -gt 20) { Write-Host ('  … 还有 ' + ($total - 20) + ' 项') }

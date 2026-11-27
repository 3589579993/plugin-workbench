<#
AI 助手启动器（Windows PowerShell 版）
---------------------------------------------------------------
用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File open-ai.ps1 <模型名>
      可选参数：-DryRun  只打印计划，不弹窗/不下载/不启动
                -Missing 假装本机什么都没装（测试用）
                -Choice install|page|cli|web|cancel  跳过弹窗直接选

为什么不用 Node：
  普通用户的电脑上不一定装了 Node.js。如果启动器本身要用 node 跑，
  “没装 AI 时引导安装”就会先卡在“没装 Node”上。PowerShell 是
  Windows 10/11 自带的，所以这里完全不需要 Node。

点击按钮后的顺序：
  1. 本机已装桌面版 → 直接打开桌面版；
  2. 本机已装命令行版 → 新窗口启动命令行版；
  3. 都没装 → 弹窗让用户选：
       · 自动下载安装包到「下载」并启动安装（有官方直链的模型）
       · 打开官方下载页
       · 安装命令行版（本机有 npm 时）
       · 先用网页版
       · 取消
#>

param(
  [Parameter(Position = 0)][string]$Model = '',
  [switch]$DryRun,
  [switch]$Missing,
  [string]$Choice = ''
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Write-Line([string]$Text = '') {
  [Console]::Out.WriteLine($Text)
}

$NodeDownload = 'https://nodejs.org/en/download'

# 每个模型的资料。InstallerUrl 必须是**官方**安装包直链；
# 拿不到可靠直链的就留空，改为打开官方下载页，不编造地址。
$Models = [ordered]@{
  claude = @{
    Label        = 'Claude（Anthropic）'
    Cli          = @('claude')
    CliPkg       = '@anthropic-ai/claude-code'
    AppMatch     = 'Claude'
    InstallerUrl = 'https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest-win-x64/Claude-Setup-x64.exe'
    InstallerFile = 'Claude-Setup-x64.exe'
    Url          = 'https://claude.ai/new'
    DownloadUrl  = 'https://claude.ai/download'
  }
  deepseek = @{
    Label        = 'DeepSeek（深度求索）'
    Cli          = @('deepseek')
    CliPkg       = $null
    AppMatch     = 'DeepSeek'
    InstallerUrl = $null
    InstallerFile = $null
    Url          = 'https://chat.deepseek.com/'
    DownloadUrl  = 'https://www.deepseek.com/'
  }
  gemini = @{
    Label        = 'Gemini（Google）'
    Cli          = @('gemini')
    CliPkg       = '@google/gemini-cli'
    AppMatch     = 'Gemini'
    InstallerUrl = $null
    InstallerFile = $null
    Url          = 'https://gemini.google.com/app'
    DownloadUrl  = 'https://github.com/google-gemini/gemini-cli'
  }
  doubao = @{
    Label        = '豆包（字节跳动）'
    Cli          = @('doubao')
    CliPkg       = $null
    AppMatch     = '豆包|Doubao'
    InstallerUrl = $null
    InstallerFile = $null
    Url          = 'https://www.doubao.com/chat/'
    DownloadUrl  = 'https://www.doubao.com/download'
  }
  chatgpt = @{
    Label        = 'ChatGPT（OpenAI，本机用 Codex）'
    Cli          = @('codex', 'chatgpt')
    CliPkg       = '@openai/codex'
    AppMatch     = 'ChatGPT|Codex'
    InstallerUrl = $null
    InstallerFile = $null
    Url          = 'https://chatgpt.com/'
    DownloadUrl  = 'https://openai.com/chatgpt/download/'
  }
  qwen = @{
    Label        = '通义千问（阿里）'
    Cli          = @('qwen')
    CliPkg       = '@qwen-code/qwen-code'
    AppMatch     = '通义|千问|Qwen'
    InstallerUrl = $null
    InstallerFile = $null
    Url          = 'https://tongyi.aliyun.com/qianwen/'
    DownloadUrl  = 'https://tongyi.aliyun.com/qianwen/'
  }
}

$script:StartAppsCache = $null

function Get-InstalledApps {
  if ($null -ne $script:StartAppsCache) { return $script:StartAppsCache }
  $script:StartAppsCache = @()
  try {
    $script:StartAppsCache = @(Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -and $_.AppID })
  } catch {
    $script:StartAppsCache = @()
  }
  return $script:StartAppsCache
}

function Find-DesktopApp($m) {
  foreach ($app in (Get-InstalledApps)) {
    if ($app.Name -match $m.AppMatch) { return $app }
  }
  return $null
}

function Find-Cli($m) {
  foreach ($name in $m.Cli) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd }
  }
  return $null
}

function Get-Npm {
  return (Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Start-DesktopApp($app) {
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $app.AppID) | Out-Null
}

function Start-Cli($cli) {
  $path = [string]$cli.Source
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', ('"' + $path + '"') | Out-Null
}

function Open-Url([string]$url) {
  if (-not $url) { return }
  Start-Process $url | Out-Null
}

function Show-InstallDialog($m, $options, [string]$detail) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'AI 助手 · ' + $m.Label
  $form.ClientSize = New-Object System.Drawing.Size(620, 360)
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.TopMost = $true
  $form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = '没有在本机找到 ' + $m.Label
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $title.SetBounds(20, 18, 580, 28)
  $form.Controls.Add($title)

  $body = New-Object System.Windows.Forms.Label
  $body.Text = $detail
  $body.AutoSize = $false
  $body.SetBounds(20, 54, 580, 184)
  $form.Controls.Add($body)

  $script:DialogChoice = ''
  $cancelButton = $null
  $defaultButton = $null
  $x = 20
  $y = 250
  foreach ($opt in $options) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = [string]$opt.Text
    $btn.Tag = [string]$opt.Key
    $btn.SetBounds($x, $y, 138, 36)
    if ($opt.Primary) {
      $btn.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
      $defaultButton = $btn
    }
    $btn.Add_Click({
      $script:DialogChoice = [string]$this.Tag
      $form.Close()
    })
    $form.Controls.Add($btn)
    if ($opt.Key -eq 'cancel') { $cancelButton = $btn }
    $x += 146
    if ($x -gt 600) { $x = 20; $y += 44 }
  }
  if ($defaultButton) { $form.AcceptButton = $defaultButton }
  if ($cancelButton) { $form.CancelButton = $cancelButton }

  [void]$form.ShowDialog()
  $form.Dispose()
  return $script:DialogChoice
}

function Build-Detail($m, [bool]$hasInstaller, [bool]$hasNpm) {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('这台电脑上还没有找到 ' + $m.Label + '。')
  $lines.Add('')
  if ($hasInstaller) {
    $lines.Add('「自动下载并安装」：从官方地址把安装包下载到「下载」文件夹，并启动安装程序。')
    $lines.Add('安装完成后回到工作台，再点一次这个按钮就会直接打开它。')
  } else {
    $lines.Add('「打开官方下载页」：用浏览器打开官方页面，按页面提示把 ' + $m.Label + ' 装到电脑上。')
  }
  if ($m.CliPkg -and $hasNpm) {
    $lines.Add('')
    $lines.Add('「安装命令行版」：用 npm 安装 ' + $m.CliPkg + '，适合喜欢在终端里用的人。')
  } elseif ($m.CliPkg) {
    $lines.Add('')
    $lines.Add('（本机没有 npm；需要命令行版的话，会先带你下载 Node.js。）')
  }
  $lines.Add('')
  $lines.Add('网页版：' + $m.Url)
  return ($lines -join "`r`n")
}

function Save-Installer($m) {
  $dir = Join-Path $env:USERPROFILE 'Downloads'
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $out = Join-Path $dir $m.InstallerFile
  $tmp = $out + '.part'
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }

  Write-Line ('  下载地址：' + $m.InstallerUrl)
  Write-Line ('  保存到：' + $out)

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $req = [Net.HttpWebRequest]::Create([string]$m.InstallerUrl)
  $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PluginWorkbench-AIAssistant/1.2'
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 60000

  $resp = $null
  $total = [int64]0
  $done = [int64]0
  try {
    $resp = $req.GetResponse()
    $total = [int64]$resp.ContentLength
    $inStream = $resp.GetResponseStream()
    $outStream = [System.IO.File]::Create($tmp)
    try {
      $buf = New-Object byte[] 81920
      $last = [DateTime]::UtcNow
      while (($n = $inStream.Read($buf, 0, $buf.Length)) -gt 0) {
        $outStream.Write($buf, 0, $n)
        $done += $n
        $now = [DateTime]::UtcNow
        if (($now - $last).TotalMilliseconds -ge 800) {
          $last = $now
          if ($total -gt 0) {
            $pct = [Math]::Floor($done * 100 / $total)
            [Console]::Out.Write(("`r  已下载 {0:N1} MB / {1:N1} MB（{2}%）" -f ($done / 1MB), ($total / 1MB), $pct))
          } else {
            [Console]::Out.Write(("`r  已下载 {0:N1} MB" -f ($done / 1MB)))
          }
        }
      }
    } finally {
      $outStream.Dispose()
      $inStream.Dispose()
    }
  } finally {
    if ($resp) { $resp.Dispose() }
  }

  [Console]::Out.WriteLine('')
  if ($total -gt 0 -and $done -ne $total) {
    throw ('下载不完整：' + $done + '/' + $total + ' 字节')
  }
  if ((Get-Item -LiteralPath $tmp).Length -lt 1MB) {
    throw '下载下来的文件太小，可能不是安装包'
  }
  Move-Item -LiteralPath $tmp -Destination $out -Force
  Write-Line ('  ✓ 下载完成：' + $out)
  return $out
}

function Show-Signature([string]$file) {
  try {
    $sig = Get-AuthenticodeSignature -FilePath $file
    $subject = ''
    if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
    Write-Line ('  数字签名：' + $sig.Status + $(if ($subject) { ' / ' + $subject } else { '' }))
  } catch { }
}

function Install-Cli($m, $npm) {
  if (-not $npm) {
    Write-Line ('  本机没有 npm，先打开 Node.js 下载页：' + $NodeDownload)
    Open-Url $NodeDownload
    return
  }
  $line = 'chcp 65001 >nul & npm install -g ' + $m.CliPkg + ' && echo. && echo 安装完成，请回到工作台再点一次 ' + $m.Label + '。'
  Write-Line ('  正在新窗口安装：npm install -g ' + $m.CliPkg)
  Write-Line '  安装完成后回到工作台，再点一次这个按钮即可。'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $line | Out-Null
}

function Invoke-Install($m) {
  if (-not $m.InstallerUrl) {
    Write-Line ('  这个模型没有可自动下载的官方安装包，改为打开下载页：' + $m.DownloadUrl)
    Open-Url $m.DownloadUrl
    return
  }
  Write-Line '  正在从官方地址下载安装包…'
  try {
    $file = Save-Installer $m
    Show-Signature $file
    Write-Line '  正在启动安装程序…'
    Start-Process -FilePath $file | Out-Null
    Write-Line '  安装程序已启动。按提示完成后，回到工作台再点一次即可直接打开。'
  } catch {
    Write-Line ('  ✗ 自动下载失败：' + $_.Exception.Message)
    Write-Line ('  改为打开官方下载页：' + $m.DownloadUrl)
    Open-Url $m.DownloadUrl
  }
}

function Get-StateText($m) {
  $app = Find-DesktopApp $m
  if ($app) { return '桌面版：' + $app.Name }
  $cli = Find-Cli $m
  if ($cli) { return '命令行版：' + $cli.Source }
  return '未安装'
}

# ── 入口 ────────────────────────────────────────────────────────
$key = [string]$Model
if ($key -eq '') { $key = 'list' }
$key = $key.ToLowerInvariant()

if ($key -eq 'list') {
  foreach ($k in $Models.Keys) {
    $m = $Models[$k]
    $state = Get-StateText $m
    $pkg = if ($m.CliPkg) { '   npm: ' + $m.CliPkg } else { '' }
    Write-Line ($k.PadRight(9) + ' ' + $m.Label + '   ' + $state + $pkg)
  }
  exit 0
}

$m = $Models[$key]
if (-not $m) {
  [Console]::Error.WriteLine('未知的模型：' + $Model)
  [Console]::Error.WriteLine('可用：' + (($Models.Keys) -join ', '))
  exit 1
}

Write-Line ('▸ ' + $m.Label)

$app = $null
$cli = $null
if (-not $Missing) {
  $app = Find-DesktopApp $m
  $cli = Find-Cli $m
}

if ($app) {
  Write-Line ('  本机已安装桌面版：' + $app.Name + '（' + $app.AppID + '）')
  if ($DryRun) {
    Write-Line '  将直接打开这个桌面版。'
    Write-Line '（dry-run：没有真的启动）'
    exit 0
  }
  Start-DesktopApp $app
  Write-Line '  已打开。'
  exit 0
}

if ($cli) {
  Write-Line ('  本机已安装命令行版：' + $cli.Source)
  if ($DryRun) {
    Write-Line '  将在新窗口启动命令行版。'
    Write-Line '（dry-run：没有真的启动）'
    exit 0
  }
  Write-Line '  正在新窗口启动…'
  Start-Cli $cli
  exit 0
}

Write-Line ('  本机未安装 ' + $m.Label + $(if ($Missing) { '（模拟）' } else { '' }) + '。')

$npm = Get-Npm
$hasNpm = [bool]$npm

$options = New-Object System.Collections.Generic.List[object]
if ($m.InstallerUrl) {
  $options.Add(@{ Key = 'install'; Text = '自动下载并安装'; Primary = $true })
} else {
  $options.Add(@{ Key = 'page'; Text = '打开官方下载页'; Primary = $true })
}
if ($m.InstallerUrl) {
  $options.Add(@{ Key = 'page'; Text = '打开官方下载页'; Primary = $false })
}
if ($m.CliPkg) {
  $options.Add(@{ Key = 'cli'; Text = '安装命令行版'; Primary = $false })
}
$options.Add(@{ Key = 'web'; Text = '先用网页版'; Primary = $false })
$options.Add(@{ Key = 'cancel'; Text = '取消'; Primary = $false })

$detail = Build-Detail $m ([bool]$m.InstallerUrl) $hasNpm

if ($DryRun) {
  Write-Line '  可选择：'
  foreach ($opt in $options) { Write-Line ('    · ' + $opt.Text) }
  if ($Choice) {
    $chosen = ([string]$Choice).ToLowerInvariant()
    $plan = switch ($chosen) {
      'install' {
        if ($m.InstallerUrl) { '自动下载并安装：' + $m.InstallerUrl }
        else { '打开官方下载页：' + $m.DownloadUrl }
      }
      'page' { '打开官方下载页：' + $m.DownloadUrl }
      'cli' {
        if (-not $m.CliPkg) { '这个模型没有命令行版' }
        elseif ($hasNpm) { '安装命令行版：npm install -g ' + $m.CliPkg }
        else { '打开 Node.js 下载页：' + $NodeDownload }
      }
      'web' { '打开网页版：' + $m.Url }
      default { '取消' }
    }
    Write-Line ('  已选择：' + $plan)
  }
  if ($m.InstallerUrl) {
    Write-Line ('  自动下载：' + $m.InstallerUrl)
    Write-Line ('  保存到：' + (Join-Path (Join-Path $env:USERPROFILE 'Downloads') $m.InstallerFile))
  }
  Write-Line ('  官方下载页：' + $m.DownloadUrl)
  Write-Line ('  网页版：' + $m.Url)
  Write-Line ('  命令行版：' + $(if ($m.CliPkg) { $m.CliPkg } else { '（无）' }) + '   npm：' + $(if ($hasNpm) { '可用' } else { '未安装' }))
  Write-Line '（dry-run：没有真的弹窗、下载或启动）'
  exit 0
}

$action = $Choice
if (-not $action) {
  $action = Show-InstallDialog $m $options $detail
}
if (-not $action) { $action = 'cancel' }
$action = ([string]$action).ToLowerInvariant()

switch ($action) {
  'install' {
    Invoke-Install $m
  }
  'page' {
    Write-Line ('  打开官方下载页：' + $m.DownloadUrl)
    Open-Url $m.DownloadUrl
  }
  'cli' {
    Install-Cli $m $npm
  }
  'web' {
    Write-Line ('  打开网页版：' + $m.Url)
    Open-Url $m.Url
  }
  default {
    Write-Line '  已取消。'
  }
}

exit 0

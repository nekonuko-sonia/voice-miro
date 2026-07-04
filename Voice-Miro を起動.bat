@echo off
chcp 65001 >nul
title Voice-Miro （このウィンドウを閉じると停止します）
cd /d "%~dp0"

rem --- Node を探す（PATH → よくある場所） ---
set NODE=
where node >nul 2>nul && set NODE=node
if "%NODE%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
if "%NODE%"=="" (
  echo.
  echo   [!] Node.js が見つかりませんでした。
  echo       https://nodejs.org/ja から LTS 版を1回だけインストールしてください。
  echo.
  pause
  exit /b 1
)

rem --- claude CLI 有無＆ログイン確認（画面にも案内は出るが、ここでも先に知らせる） ---
where claude >nul 2>nul && (
  claude auth status 2>nul | findstr /C:"\"loggedIn\": true" >nul || (
    echo.
    echo   [注意] Claude にログインしていない可能性があります。
    echo          このあと使えない場合は、コマンドプロンプトで  claude auth login  を実行してください。
  )
) || (
  echo.
  echo   [注意] claude コマンドが見つかりません。Claude Code をインストール＆ログインしてください。
)

echo.
echo   Voice-Miro を起動しています... しばらくするとブラウザが開きます。
echo.
%NODE% --no-deprecation server.js
echo.
echo   停止しました。ウィンドウを閉じて構いません。
pause

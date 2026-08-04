1 команда установки
iex (irm https://hermes-agent.nousresearch.com/install.ps1)

После установки:

```shell
~ source/.bashrc # перезагрузить оболочку (или: source ~/.zshrc)
hermes # начать общение!
```


### Устранение неполадок

#### Защитник Windows или антивирус помечает `uv.exe` как вредоносное ПО


Если ваш антивирус (Bitdefender, Защитник Windows и т. д.) помещает `uv.exe` из папки Hermes `bin` (`%LOCALAPPDATA%\hermes\bin\uv.exe`), это **ложное срабатывание**. Этот файл является частью `uv` — менеджера пакетов Rust Python, который использует Hermes для управления своей средой Python. Антивирусные системы на основе машинного обучения часто помечают неподписанные двоичные файлы Rust, которые загружают и устанавливают пакеты.

**Чтобы убедиться, что ваша копия подлинная:**

```powershell
# При необходимости установите GitHub CLI
winget install --id GitHub.cli

# Авторизоваться на GitHub
gh auth login

# Запустить проверку
$uv = "$env:LOCALAPPDATA\hermes\bin\uv.exe"
$ver = (& $uv --version).Split(' ')[1]
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$zip = "$env:TEMP\uv.zip"
Invoke-WebRequest "https://github.com/astral-sh/uv/releases/download/$ver/uv-x86_64-pc-windows-msvc.zip" -OutFile $zip -UseBasicParsing
gh attestation verify $zip --repo astral-sh/uv
Expand-Archive $zip "$env:TEMP\uv_x" -Force
(Get-FileHash "$env:TEMP\uv_x\uv.exe").Hash -eq (Get-FileHash $uv).Hash
```

Если при аттестации указано «Проверка прошла успешно» и в последней строке выводится `True`, значит, все в порядке.

**Чтобы внести Hermes в белый список:**

- **Защитник Windows:** запустите PowerShell от имени администратора → `Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\hermes\bin"`
- **Bitdefender:** Добавьте исключение в консоли Bitdefender (Защита> Антивирус> Настройки> Управление исключениями).
- Внесите в белый список **папку**, а не хэш файла — Hermes обновляет `uv` и хэш меняется с каждой версией


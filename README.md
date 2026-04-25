# mcp-dotnet

[Русская версия ниже / Russian version below](#mcp-dotnet-ru)

A small Model Context Protocol (MCP) server that lets an LLM **read .NET
assemblies as C#**. It is a thin wrapper around the official ILSpy CLI
(`ilspycmd`), exposed over stdio so any MCP-capable client can list types,
decompile a single class, decompile the whole assembly into a project tree,
or grep across the decompiled source.

## Why this exists

LLMs are good at reading source code, not raw IL bytecode. ILSpy already
turns CIL into faithful C#, but invoking it from a chat agent is awkward —
you end up shelling out to `ilspycmd` by hand and pasting the output back
into the conversation. This server formalizes that loop:

* `list-types` first, so the model knows which type to look at without
  dumping a megabyte of decompilation into context.
* `decompile-type` for targeted reads — one fully-qualified class at a time.
* `decompile-assembly` when the model genuinely wants the whole project
  tree, e.g. before running a project-wide grep.
* `search-source` decompiles once, caches the output, and greps across all
  the resulting `.cs` files. Subsequent searches reuse the cached tree.

The target assembly is **never executed**. Everything is static.

It also handles the common modern case of **.NET 6/7/8 single-file
deployments** — point `path` at the published `.exe` and ILSpy 10+ resolves
the embedded core assembly automatically.

## Tools

| Tool                | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `list-types`        | List declared types in an assembly. Optional `kinds` filter (c/i/s/d/e).                  |
| `decompile-type`    | Decompile one fully-qualified type to C#. Optional IL appended via `includeIl`.           |
| `decompile-assembly`| Decompile to a folder of `.cs` files (a compilable project).                              |
| `search-source`     | Decompile (once, cached) and grep the C# tree for a regex; returns file/line/snippet.    |

## Install

```bash
# 1. ILSpy CLI (one-time, requires .NET SDK 6+)
dotnet tool install --global ilspycmd

# 2. This server
git clone https://github.com/beekamai/mcp-dotnet.git
cd mcp-dotnet
npm install
npm run build
```

If `ilspycmd` is not on PATH, set the `ILSPYCMD` environment variable to its
absolute path. The server also auto-detects the default
`%USERPROFILE%\.dotnet\tools\ilspycmd.exe` location on Windows and
`~/.dotnet/tools/ilspycmd` on POSIX.

Wire it into any MCP-capable client over stdio:

```bash
your-mcp-client mcp add dotnet --scope user -- node /absolute/path/to/mcp-dotnet/dist/index.js
```

## Notes

* All tools take **absolute paths**. Working directory differences between
  the MCP client and this server are common, so the server refuses to guess.
* `decompile-assembly` and the first `search-source` on a fresh assembly can
  take tens of seconds to several minutes depending on size — the timeout is
  10 minutes.
* `search-source` caches the decompiled tree under
  `<assemblyDir>/.mcp-dotnet-<assemblyName>/` by default. Pass an explicit
  `outDir` to control placement, or delete the cache to force re-decompilation.
* The server runs `ilspycmd` as a child process and never exposes its stdin.
  No code from the target assembly is executed at any point.

## License

MIT.

---

<a id="mcp-dotnet-ru"></a>

# mcp-dotnet (RU)

Небольшой MCP-сервер, который даёт языковой модели возможность **читать
.NET-сборки как C#-исходники**. Это тонкая обёртка над официальной
консольной утилитой ILSpy (`ilspycmd`) поверх stdio: модель может получить
список типов, декомпилировать один класс, развернуть всю сборку в дерево
`.cs`-файлов или прогнать regex по исходнику.

## Зачем это нужно

LLM хорошо читают исходный код и плохо — IL. ILSpy и так умеет превращать
CIL в адекватный C#, но дёргать `ilspycmd` руками из чата неудобно — каждый
раз shell-out и копипаст в контекст. Этот сервер формализует цикл:

* Сначала `list-types`, чтобы модель не тащила мегабайты декомпила в
  контекст ради того, чтобы выяснить какой класс ей нужен.
* `decompile-type` — точечно один полностью-квалифицированный тип.
* `decompile-assembly` — когда нужен весь проектный tree (например, чтобы
  потом сделать project-wide grep).
* `search-source` — декомпилирует один раз, кэширует результат и ищет regex
  по всем `.cs`. Повторные поиски используют кэш.

Целевую сборку **никто не запускает**. Всё статично.

Сервер также корректно работает с **single-file deployment .NET 6/7/8** —
указываешь `path` на опубликованный `.exe`, ILSpy 10+ сам находит
встроенный основной assembly.

## Тулы

| Тул                  | Что делает                                                                       |
| -------------------- | -------------------------------------------------------------------------------- |
| `list-types`         | Список типов сборки. Опциональный фильтр `kinds` (c/i/s/d/e).                    |
| `decompile-type`     | Декомпиляция одного типа в C#. С опциональным IL через `includeIl`.              |
| `decompile-assembly` | Развёртывает сборку в папку `.cs`-файлов (компилируемый проект).                 |
| `search-source`      | Один раз декомпилирует (с кэшем), потом regex-grep по `.cs` — возвращает file/line/snippet. |

## Установка

```bash
# 1. ILSpy CLI (один раз, нужен .NET SDK 6+)
dotnet tool install --global ilspycmd

# 2. Сам сервер
git clone https://github.com/beekamai/mcp-dotnet.git
cd mcp-dotnet
npm install
npm run build
```

Если `ilspycmd` не попал в PATH — выставь переменную окружения `ILSPYCMD`
с абсолютным путём. Сервер также автоматически находит дефолтные пути:
`%USERPROFILE%\.dotnet\tools\ilspycmd.exe` на Windows и
`~/.dotnet/tools/ilspycmd` на POSIX.

Подключение к MCP-клиенту через stdio:

```bash
your-mcp-client mcp add dotnet --scope user -- node /абсолютный/путь/к/mcp-dotnet/dist/index.js
```

## Заметки

* Все тулы принимают **абсолютные пути**. Рабочая директория MCP-клиента и
  сервера часто различаются, поэтому сервер ничего не угадывает.
* `decompile-assembly` и первый `search-source` на свежей сборке могут
  занимать от десятков секунд до нескольких минут — таймаут 10 минут.
* `search-source` кэширует декомпилированное дерево в
  `<dir-сборки>/.mcp-dotnet-<имя-сборки>/`. Если хочется в другое место —
  передай `outDir` явно. Удаление каталога заставит декомпилировать заново.
* `ilspycmd` запускается дочерним процессом, его stdin не пробрасывается.
  Код целевой сборки нигде не исполняется.

## Лицензия

MIT.

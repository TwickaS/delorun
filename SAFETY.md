# Safety

English | [中文](SAFETY.zh.md)

<!-- DRAFT FOR THE OWNER: rewrite every section in your own words, then delete this comment and the note below. -->

> **Draft.** The maintainer has not yet rewritten this notice in the maintainer's own words. The facts are right; the voice is a first pass.

## Preview status

Delorun is preview software. Its releases are signed with preview keys, it has had no outside security review, and one person maintains it. Do not treat it as secure or ready for production. [What you trust when you use Delorun](delorun/docs/guide/trust.md) says what each of these means.

Delorun can run code and commands that a model wrote, load third-party plugins, and reach the network, processes, credentials and files you make available to it. A model's mistake, a defect, a wrong setting, hostile input or an untrusted plugin may damage your computer, change or delete files, disclose data or credentials, or cause other harm.

## What the sandbox does not do

The sandbox, the approval prompts and the permission settings lower the risk. They do not guarantee isolation or prevent damage, and no restriction protects what you have allowed Delorun to reach. [What Delorun protects](delorun/docs/guide/safety.md) lists each protection and each limit.

Do not rely on Delorun as your only protection when you run work you do not trust.

## Using it responsibly

- Run Delorun with the least access the work needs.
- Prefer a virtual machine, a container or a computer set aside for it.
- Keep backups of the files Delorun can reach, and keep your projects in git: Delorun does not undo what an agent did to your files.
- Do not give it credentials or data unless you accept the risk.
- Review plugins, settings and proposed commands before you allow them.

## No warranty or liability

Use Delorun at your own risk. The software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for damage to computers, loss or disclosure of data, loss of files, or other harm arising from use of the project.

This notice is based on the safety notice of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), on which Delorun is built.

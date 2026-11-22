# Safety

English | [中文](SAFETY.zh.md)

## Preview status

I build and maintain Delorun, and it is preview software. I sign its releases with preview keys, nobody outside the project has reviewed its security, and I am the only maintainer. Do not treat it as secure or ready for production. [What you trust when you use Delorun](delorun/docs/guide/safety-and-updates/trust.md) explains what each of these means.

Delorun runs code and commands that a model wrote, loads third-party plugins, and reaches the network, processes, credentials and files you make available to it. A model's mistake, a defect, a wrong setting, hostile input or an untrusted plugin can damage your computer, change or delete files, disclose data or credentials, or cause other harm.

## What the sandbox does not do

The sandbox, the approval prompts and the permission settings lower the risk. They do not guarantee isolation or prevent damage, and no restriction protects what you allow Delorun to reach. [What Delorun protects](delorun/docs/guide/safety-and-updates/safety.md) lists each protection and each limit.

Do not rely on Delorun as your only protection when you run work you do not trust.

## Using it responsibly

- Run Delorun with the least access the work needs.
- Prefer a virtual machine, a container or a computer set aside for it.
- Keep backups of the files Delorun can reach, and keep your projects in git: Delorun does not undo what an agent did to your files.
- Do not give it credentials or data unless you accept the risk.
- Review plugins, settings and proposed commands before you allow them.

## No warranty or liability

You use Delorun at your own risk. The software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for damage to computers, loss or disclosure of data, loss of files, or other harm arising from use of the project.

To report a security problem, follow [SECURITY.md](SECURITY.md). For anything else, use the contact details in [SUPPORT.md](SUPPORT.md).

This notice is based on the safety notice of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), on which Delorun is built.

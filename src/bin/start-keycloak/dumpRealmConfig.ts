import { runPrettier, getIsPrettierAvailable } from "../tools/runPrettier";
import { CONTAINER_NAME } from "../shared/constants";
import child_process from "child_process";
import { join as pathJoin } from "path";
import chalk from "chalk";
import { Deferred } from "evt/tools/Deferred";
import { assert, is } from "tsafe/assert";
import type { BuildContext } from "../shared/buildContext";
import * as fs from "fs/promises";

export type BuildContextLike = {
    cacheDirPath: string;
};

assert<BuildContext extends BuildContextLike ? true : false>();

export async function dumpRealmConfig(params: {
    realmName: string;
    keycloakMajorVersionNumber: number;
    targetRealmConfigJsonFilePath: string;
    buildContext: BuildContextLike;
}) {
    const {
        realmName,
        keycloakMajorVersionNumber,
        targetRealmConfigJsonFilePath,
        buildContext
    } = params;

    {
        // https://github.com/keycloak/keycloak/issues/33800
        const doesUseLockedH2Database = keycloakMajorVersionNumber >= 26;

        if (doesUseLockedH2Database) {
            child_process.execSync(
                `docker exec ${CONTAINER_NAME} sh -c "cp -rp /opt/keycloak/data/h2 /tmp"`
            );
        }

        const dCompleted = new Deferred<void>();

        const child = child_process.spawn(
            "docker",
            [
                ...["exec", CONTAINER_NAME],
                ...["/opt/keycloak/bin/kc.sh", "export"],
                ...["--dir", "/tmp"],
                ...["--realm", realmName],
                ...["--users", "realm_file"],
                ...(!doesUseLockedH2Database
                    ? []
                    : [
                          ...["--db", "dev-file"],
                          ...[
                              "--db-url",
                              "'jdbc:h2:file:/tmp/h2/keycloakdb;NON_KEYWORDS=VALUE'"
                          ]
                      ])
            ],
            { shell: true }
        );

        let output = "";

        const onExit = (code: number | null) => {
            dCompleted.reject(new Error(`Exited with code ${code}`));
        };

        child.once("exit", onExit);

        child.stdout.on("data", data => {
            const outputStr = data.toString("utf8");

            if (outputStr.includes("Export finished successfully")) {
                child.removeListener("exit", onExit);

                // NOTE: On older Keycloak versions the process keeps running after the export is done.
                const timer = setTimeout(() => {
                    child.removeListener("exit", onExit2);
                    child.kill();
                    dCompleted.resolve();
                }, 1500);

                const onExit2 = () => {
                    clearTimeout(timer);
                    dCompleted.resolve();
                };

                child.once("exit", onExit2);
            }

            output += outputStr;
        });

        child.stderr.on("data", data => (output += chalk.red(data.toString("utf8"))));

        try {
            await dCompleted.pr;
        } catch (error) {
            assert(is<Error>(error));

            console.log(chalk.red(error.message));

            console.log(output);

            process.exit(1);
        }

        if (doesUseLockedH2Database) {
            const dCompleted = new Deferred<void>();

            child_process.exec(
                `docker exec ${CONTAINER_NAME} sh -c "rm -rf /tmp/h2"`,
                error => {
                    if (error !== null) {
                        dCompleted.reject(error);
                        return;
                    }

                    dCompleted.resolve();
                }
            );

            await dCompleted.pr;
        }
    }

    const targetRealmConfigJsonFilePath_tmp = pathJoin(
        buildContext.cacheDirPath,
        "realm.json"
    );

    {
        const dCompleted = new Deferred<void>();

        child_process.exec(
            `docker cp ${CONTAINER_NAME}:/tmp/${realmName}-realm.json ${targetRealmConfigJsonFilePath_tmp}`,
            error => {
                if (error !== null) {
                    dCompleted.reject(error);
                    return;
                }

                dCompleted.resolve();
            }
        );

        await dCompleted.pr;
    }

    let sourceCode = (await fs.readFile(targetRealmConfigJsonFilePath_tmp)).toString(
        "utf8"
    );

    run_prettier: {
        if (!(await getIsPrettierAvailable())) {
            break run_prettier;
        }

        sourceCode = await runPrettier({
            filePath: targetRealmConfigJsonFilePath,
            sourceCode: sourceCode
        });
    }

    await fs.writeFile(targetRealmConfigJsonFilePath, Buffer.from(sourceCode, "utf8"));
}

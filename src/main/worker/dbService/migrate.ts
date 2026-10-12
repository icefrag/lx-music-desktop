import type Database from 'better-sqlite3'
import tables, { DB_VERSION } from './tables'

// const migrateV1 = (db: Database.Database) => {
//   const sql = `
//     DROP TABLE "main"."download_list";

//     CREATE TABLE "download_list" (
//       "id" TEXT NOT NULL,
//       "isComplate" INTEGER NOT NULL,
//       "status" TEXT NOT NULL,
//       "statusText" TEXT NOT NULL,
//       "progress_downloaded" INTEGER NOT NULL,
//       "progress_total" INTEGER NOT NULL,
//       "url" TEXT,
//       "quality" TEXT NOT NULL,
//       "ext" TEXT NOT NULL,
//       "fileName" TEXT NOT NULL,
//       "filePath" TEXT NOT NULL,
//       "musicInfo" TEXT NOT NULL,
//       "position" INTEGER NOT NULL,
//       PRIMARY KEY("id")
//     );
//   `
//   db.exec(sql)
//   db.prepare('UPDATE "main"."db_info" SET "field_value"=@value WHERE "field_name"=@name').run({ name: 'version', value: '2' })
// }

const migrateV1 = (db: Database.Database) => {
  // 修复 v2.4.0 的默认数据库版本号不对的问题
  const existsTable = db.prepare('SELECT name FROM "main".sqlite_master WHERE type=\'table\' AND name=\'dislike_list\';').get()
  if (!existsTable) {
    const sql = tables.get('dislike_list')!
    db.exec(sql)
  }
}

const migrateV2 = (db: Database.Database) => {
  // download_list 增加逐任务保存目录（开放 API 下载端点的 dir 参数）
  const existsCol = db.prepare('SELECT name FROM pragma_table_info(\'download_list\') WHERE name = \'savePath\'').get()
  if (!existsCol) db.exec('ALTER TABLE "main"."download_list" ADD COLUMN "savePath" TEXT;')
}

const migrateV3 = (db: Database.Database) => {
  // download_list 增加结构化错误码（开放 API /download-status 的 errorCode 字段）
  const existsCol = db.prepare('SELECT name FROM pragma_table_info(\'download_list\') WHERE name = \'errorCode\'').get()
  if (!existsCol) db.exec('ALTER TABLE "main"."download_list" ADD COLUMN "errorCode" TEXT;')
}

export default (db: Database.Database) => {
  // PRAGMA user_version = x
  // console.log(db.prepare('PRAGMA user_version').get().user_version)
  // https://github.com/WiseLibs/better-sqlite3/issues/668#issuecomment-1145285728
  const version = (db.prepare<[string]>('SELECT "field_value" FROM "main"."db_info" WHERE "field_name" = ?').get('version') as { field_value: string }).field_value
  switch (version) {
    case '1':
      migrateV1(db)
      // falls through
    case '2':
      migrateV2(db)
      // falls through
    case '3':
      migrateV3(db)
      db.prepare('UPDATE "main"."db_info" SET "field_value"=@value WHERE "field_name"=@name').run({ name: 'version', value: DB_VERSION })
      break
  }
}

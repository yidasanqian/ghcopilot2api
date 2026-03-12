import config from "@echristian/eslint-config"

export default config({
  prettier: {
    endOfLine: "auto",
    plugins: ["prettier-plugin-packagejson"],
  },
})

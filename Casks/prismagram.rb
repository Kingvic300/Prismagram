cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "0.4.3"
  sha256 arm:   "da36eb52f1b5c9980635fe2c794439bfb6ff0a5648cede53228b527f9b3e2322",
         intel: "35036c4f3c27a03fe341803d2964a61416c43488c11717c5e43a37ee58e1883f"

  url "https://github.com/Kingvic300/Prismagram/releases/download/v#{version}/Prismagram_#{version}_#{arch}.dmg"
  name "Prismagram"
  desc "Prisma schema diagrams and a database client"
  homepage "https://kingvic300.github.io/Prismagram/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "Prismagram.app"

  zap trash: "~/Library/Application Support/io.github.kingvic300.prismagram"

  caveats <<~EOS
    Prismagram is not code-signed yet. If macOS says it cannot be opened, run:
      xattr -dr com.apple.quarantine "#{appdir}/Prismagram.app"
  EOS
end

cask "prismagram" do
  arch arm: "aarch64", intel: "x64"

  version "0.3.0"
  sha256 arm:   "a67c8d6201fd8d0a19f93ade614d6b212d4499753253e4b7765f6167b25e288b",
         intel: "36db2c23e08fde8c6417abbb072b18aa4294b494f884cc0b5bbf0c4a91f58dea"

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
